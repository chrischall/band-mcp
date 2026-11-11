import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { McpToolError, WriteOutcomeUnknownError, writeOutcomeStatus } from '@chrischall/mcp-utils';
import { AKEY, API_BASE, BandApiError, BandClient, tzOffsetMs } from '../src/client.js';
import { BandSessionError } from '../src/session.js';
import type { SessionCookies } from '../src/transport.js';
import { NOW_MS, SECRET, bandSessionJwt, getKeyBody, rejectionOf } from './helpers.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const ok = (data: unknown) => ({ result_code: 1, result_data: data });

interface Sent {
  url: string;
  init: RequestInit;
}

function clientWith(
  script: Array<unknown | Response | Error>,
  opts: { cookies?: () => Promise<SessionCookies>; getKey?: (t: number) => Promise<string>; env?: Record<string, string | undefined> } = {},
) {
  const jwt = bandSessionJwt();
  const queue = [...script];
  const sent: Sent[] = [];
  const readCookies = vi.fn(opts.cookies ?? (async () => ({ band_session: jwt, di: 'device-cookie-value' })));
  const fetchGetKey = vi.fn(opts.getKey ?? (async (t: number) => getKeyBody({ t, timeCorrection: NOW_MS + 1000 })));
  const client = new BandClient({
    readCookies,
    fetchGetKey,
    now: () => NOW_MS,
    env: opts.env ?? { MCP_USER_TZ: 'America/New_York' },
    fetchImpl: (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      if (queue.length === 0) throw new Error('unexpected fetch');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { client, sent, readCookies, fetchGetKey, jwt };
}

const header = (s: Sent, name: string) => (s.init.headers as Record<string, string>)[name];
const md = (pathAndQuery: string) => createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(pathAndQuery).digest('base64');

describe('tzOffsetMs', () => {
  it('is the zone offset in ms at that instant (DST-aware)', () => {
    expect(tzOffsetMs('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-18_000_000);
    expect(tzOffsetMs('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(-14_400_000);
    expect(tzOffsetMs('UTC', new Date('2026-07-15T12:00:00Z'))).toBe(0);
    expect(tzOffsetMs('Asia/Kolkata', new Date('2026-07-15T12:00:00Z'))).toBe(19_800_000);
  });
});

describe('BandClient.get', () => {
  it('sends a signed GET with ts (skew-corrected) first and the BAND headers', async () => {
    const { client, sent, jwt } = clientWith([fixture('news')]);
    const data = await client.get('/v1.2.0/get_news_count', { without_post_news: false, feed_version: 2 });
    expect(data).toEqual({ new_feed_count: 4, new_chat_message_count: 0, news_count: 2 });
    expect(sent).toHaveLength(1);
    const ts = NOW_MS + 1000;
    const pq = `/v1.2.0/get_news_count?ts=${ts}&without_post_news=false&feed_version=2`;
    expect(sent[0]!.url).toBe(`${API_BASE}${pq}`);
    expect(API_BASE).toBe('https://api-us.band.us');
    expect(sent[0]!.init.method).toBe('GET');
    expect(sent[0]!.init.body).toBeUndefined();
    expect(header(sent[0]!, 'md')).toBe(md(pq));
    expect(header(sent[0]!, 'akey')).toBe(AKEY);
    expect(header(sent[0]!, 'language')).toBe('en');
    expect(header(sent[0]!, 'cookie')).toBe(`band_session=${jwt}; di=device-cookie-value`);
    expect(header(sent[0]!, 'DEVICE-TIME-ZONE-ID')).toBe('America/New_York');
    expect(header(sent[0]!, 'DEVICE-TIME-ZONE-MS-OFFSET')).toBe(String(tzOffsetMs('America/New_York', new Date(NOW_MS))));
  });

  it("encodes an apostrophe as %27 and signs exactly what it sends", async () => {
    const { client, sent } = clientWith([ok({ items: [] })]);
    await client.get('/v2.0.0/search_posts', { band_no: 1, query: "it's" });
    const pq = sent[0]!.url.slice(API_BASE.length);
    expect(pq).toContain('query=it%27s');
    expect(header(sent[0]!, 'md')).toBe(md(pq));
  });

  it('falls back to the host zone without MCP_USER_TZ', async () => {
    const { client, sent } = clientWith([ok({})], { env: {} });
    await client.get('/v2.1.0/get_profile');
    expect(header(sent[0]!, 'DEVICE-TIME-ZONE-ID')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('lifts the session once across calls', async () => {
    const { client, readCookies } = clientWith([ok({}), ok({})]);
    await client.get('/a');
    await client.get('/b');
    expect(readCookies).toHaveBeenCalledTimes(1);
  });

  it('300 on a session cached from an earlier call → invalidates, re-lifts once, retries once', async () => {
    const { client, sent, readCookies, fetchGetKey } = clientWith([ok({}), { result_code: 300, result_data: { message: 'auth' } }, ok({ x: 1 })]);
    await client.get('/warm');
    await expect(client.get('/v2.1.0/get_profile')).resolves.toEqual({ x: 1 });
    expect(sent).toHaveLength(3);
    expect(readCookies).toHaveBeenCalledTimes(2);
    expect(fetchGetKey).toHaveBeenCalledTimes(2);
  });

  it('300 on a session lifted for this very call → BandSessionError at once (re-reading the browser would give the same)', async () => {
    const { client, sent, readCookies } = clientWith([{ result_code: 300, result_data: { message: 'auth' } }]);
    const err = await rejectionOf<BandSessionError>(client.get('/v2.1.0/get_profile'));
    expect(err).toBeInstanceOf(BandSessionError);
    expect(err.hint).toMatch(/renew/);
    expect(sent).toHaveLength(1);
    expect(readCookies).toHaveBeenCalledTimes(1);
    expect(client.session.peek()).toBeUndefined();
  });

  it('300 twice → BandSessionError telling the user to open band.us (no third attempt)', async () => {
    const no = { result_code: 300, result_data: { message: 'not authorized' } };
    const { client, sent } = clientWith([ok({}), no, no]);
    await client.get('/warm');
    const err = await rejectionOf<BandSessionError>(client.get('/v2.1.0/get_profile'));
    expect(err).toBeInstanceOf(BandSessionError);
    expect(err.message).toMatch(/300/);
    expect(err.hint).toMatch(/https:\/\/www\.band\.us\//);
    expect(err.hint).toMatch(/renew/);
    expect(sent).toHaveLength(3);
  });

  it("a stale-session 300 arriving AFTER another call's re-lift retries on that fresh session", async () => {
    const no = { result_code: 300, result_data: {} };
    let releaseB!: (r: Response) => void;
    const bAnswer = new Promise<Response>((r) => (releaseB = r));
    const answers: Array<() => Promise<Response> | Response> = [
      () => Response.json(ok({})), // warm
      () => bAnswer, // B's first send (held until A has re-lifted)
      () => Response.json(no), // A's first send
      () => Response.json(ok({ a: 1 })), // A's retry on the fresh session
      () => Response.json(ok({ b: 2 })), // B's retry on that same fresh session
    ];
    const readCookies = vi.fn(async () => ({ band_session: bandSessionJwt() }));
    const client = new BandClient({
      readCookies,
      fetchGetKey: async (t) => getKeyBody({ t }),
      now: () => NOW_MS,
      env: { MCP_USER_TZ: 'UTC' },
      fetchImpl: (async () => answers.shift()!()) as unknown as typeof fetch,
    });
    await client.get('/warm');
    const b = client.get('/b');
    await expect(client.get('/a')).resolves.toEqual({ a: 1 });
    releaseB(Response.json(no));
    await expect(b).resolves.toEqual({ b: 2 });
    expect(readCookies).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls rejected with 300 share ONE re-lift', async () => {
    const no = { result_code: 300, result_data: {} };
    const { client, sent, readCookies } = clientWith([ok({}), no, no, ok({ a: 1 }), ok({ b: 2 })]);
    await client.get('/warm');
    const results = await Promise.all([client.get('/a'), client.get('/b')]);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    expect(sent).toHaveLength(5);
    expect(readCookies).toHaveBeenCalledTimes(2);
  });

  it('non-1 result_code → BandApiError with the message and a hint', async () => {
    const { client } = clientWith([fixture('notfound')]);
    const err = await rejectionOf<BandApiError>(client.get('/v2.0.0/get_post', { band_no: 1, post_no: 2 }));
    expect(err).toBeInstanceOf(BandApiError);
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.resultCode).toBe(1000);
    expect(err.message).toContain('result_code 1000');
    expect(err.message).toContain('sample message 1');
    expect(err.hint).toMatch(/deleted|not found/i);
  });

  it.each([200, 251])('result_code %i hints at a bad parameter', async (code) => {
    const { client } = clientWith([{ result_code: code, result_data: { message: 'Temporary error' } }]);
    const err = await rejectionOf<BandApiError>(client.get('/x'));
    expect(err.hint).toMatch(/parameter/);
  });

  it('an unknown code without a message still errors, with no hint', async () => {
    const { client } = clientWith([{ result_code: 999 }]);
    const err = await rejectionOf<BandApiError>(client.get('/x'));
    expect(err.message).toContain('result_code 999');
    expect(err.hint).toBeUndefined();
  });

  it('a non-JSON or envelope-less answer is an McpToolError carrying the HTTP status', async () => {
    const a = clientWith([new Response('<html>oops</html>', { status: 502 })]);
    const err = await rejectionOf<McpToolError>(a.client.get('/x'));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.status).toBe(502);
    const b = clientWith([new Response('[1,2]', { status: 200 })]);
    await expect(b.client.get('/x')).rejects.toThrow(/unexpected answer/);
  });

  it('a GET transport failure is an McpToolError', async () => {
    const { client } = clientWith([new TypeError('fetch failed')]);
    const err = await rejectionOf<McpToolError>(client.get('/x'));
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.message).toMatch(/Could not reach BAND.*fetch failed/);
  });

  it('session errors surface as themselves (no API call)', async () => {
    const { client, sent } = clientWith([], { cookies: async () => ({}) });
    await expect(client.get('/x')).rejects.toBeInstanceOf(BandSessionError);
    expect(sent).toHaveLength(0);
  });

  it('scrubs every secret (cookie values, signing key) from error text', async () => {
    const jwt = bandSessionJwt(); // deterministic: the same token clientWith lifts
    const { client } = clientWith([{ result_code: 5, result_data: { message: `echo ${jwt} device-cookie-value ${SECRET}` } }]);
    const err = await rejectionOf<BandApiError>(client.get('/x'));
    expect(err.message).not.toContain(jwt);
    expect(err.message).not.toContain('device-cookie-value');
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('[REDACTED]');
    const t = clientWith([new Error(`boom ${SECRET}`)]);
    const tErr = await rejectionOf<Error>(t.client.get('/x'));
    expect(tErr.message).not.toContain(SECRET);
  });
});

describe('BandClient.post', () => {
  it('POSTs a form body (field order kept) with md over path?ts only', async () => {
    const { client, sent } = clientWith([ok({ post_no: 9 })]);
    const res = await client.post('/v2.0.2/create_post', { band_no: 1, content: "hi it's me & you", set_band_notice: false, copiable_state: '' });
    expect(res).toEqual({ post_no: 9 });
    const pq = `/v2.0.2/create_post?ts=${NOW_MS + 1000}`;
    expect(sent[0]!.url).toBe(`${API_BASE}${pq}`);
    expect(sent[0]!.init.method).toBe('POST');
    expect(header(sent[0]!, 'md')).toBe(md(pq));
    expect(header(sent[0]!, 'content-type')).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(sent[0]!.init.body).toBe('band_no=1&content=hi+it%27s+me+%26+you&set_band_notice=false&copiable_state=');
  });

  it('300 on a POST re-lifts and retries once (the write was refused, not applied)', async () => {
    const { client, sent } = clientWith([ok({}), { result_code: 300, result_data: {} }, ok({ done: true })]);
    await client.get('/warm');
    await expect(client.post('/w', { a: 1 })).resolves.toEqual({ done: true });
    expect(sent).toHaveLength(3);
  });

  it('a POST answered with no envelope is WriteOutcomeUnknownError (it may have landed), never replayed', async () => {
    for (const answer of [new Response('<html>502 Bad Gateway</html>', { status: 502 }), new Response('[]', { status: 200 })]) {
      const { client, sent } = clientWith([answer]);
      const err = await rejectionOf<WriteOutcomeUnknownError>(client.post('/w', { a: 1 }));
      expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
      expect(err.hint).toMatch(/Re-read/);
      expect(writeOutcomeStatus(err)).toBe(answer.status);
      expect(sent).toHaveLength(1);
    }
  });

  it('a POST transport failure is WriteOutcomeUnknownError (never replayed)', async () => {
    const { client, sent } = clientWith([new TypeError('socket hang up')]);
    const err = await rejectionOf(client.post('/w', { a: 1 }));
    expect(err).toBeInstanceOf(WriteOutcomeUnknownError);
    expect(sent).toHaveLength(1);
  });

  it('a POST timeout is WriteOutcomeUnknownError marked timedOut', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { client } = clientWith([timeout]);
    const err = (await rejectionOf(client.post('/w', { a: 1 }))) as WriteOutcomeUnknownError;
    expect(err.timedOut).toBe(true);
  });
});

describe('BandClient defaults', () => {
  it('uses the global fetch, the real clock and the default timeout when not injected', async () => {
    const globalFetch = vi.fn(async () => new Response(JSON.stringify(ok({ y: 2 })), { status: 200 }));
    vi.stubGlobal('fetch', globalFetch);
    try {
      const client = new BandClient({
        readCookies: async () => ({ band_session: bandSessionJwt() }),
        fetchGetKey: async (t) => getKeyBody({ t, timeCorrection: null }),
      });
      await expect(client.get('/v2.1.0/get_profile')).resolves.toEqual({ y: 2 });
      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [url, init] = globalFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toMatch(/^https:\/\/api-us\.band\.us\/v2\.1\.0\/get_profile\?ts=\d+$/);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a GET timeout is an McpToolError of kind timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { client } = clientWith([timeout]);
    const err = await rejectionOf<McpToolError>(client.get('/x'));
    expect(err.kind).toBe('timeout');
  });
});
