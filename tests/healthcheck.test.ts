import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import { BandClient } from '../src/client.js';
import { registerHealthcheckTool } from '../src/tools/healthcheck.js';
import { NOW_MS, bandSessionJwt, getKeyBody } from './helpers.js';

interface Result {
  ok: boolean;
  credential: { source: string | null; resolved: boolean; detail?: Record<string, unknown> };
  probe: { url?: string };
  error?: { kind: string; message: string; detail?: Record<string, unknown> };
  hint: string;
}

let harness: TestHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function run(opts: {
  cookies?: () => Promise<Record<string, string>>;
  getKey?: (t: number) => Promise<string>;
  responses?: unknown[];
}): Promise<{ result: Result; text: string; paths: string[] }> {
  const queue = [...(opts.responses ?? [])];
  const paths: string[] = [];
  const client = new BandClient({
    readCookies: opts.cookies ?? (async () => ({ band_session: bandSessionJwt(3600 + 59) })),
    fetchGetKey: opts.getKey ?? (async (t) => getKeyBody({ t, timeCorrection: NOW_MS })),
    now: () => NOW_MS,
    env: { MCP_USER_TZ: 'UTC' },
    fetchImpl: (async (url: string) => {
      paths.push(new URL(url).pathname);
      const next = queue.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      return new Response(JSON.stringify(next), { status: 200 });
    }) as unknown as typeof fetch,
  });
  harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
  const raw = await harness.callTool('band_healthcheck');
  return { result: parseToolResult<Result>(raw), text: (raw.content as { text: string }[])[0]!.text, paths };
}

describe('band_healthcheck', () => {
  it('is registered read-only', async () => {
    const client = new BandClient({ readCookies: vi.fn(), fetchGetKey: vi.fn() });
    harness = await createTestHarness((server) => registerHealthcheckTool(server, client));
    const tool = (await harness.client.listTools()).tools.find((t) => t.name === 'band_healthcheck');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('reports the source and minutes to expiry, probing get_profile', async () => {
    const { result, text, paths } = await run({ responses: [{ result_code: 1, result_data: { user_no: 1, name: 'x' } }] });
    expect(result.ok).toBe(true);
    expect(result.credential).toEqual({
      source: 'browser session (ContextMint Bridge)',
      resolved: true,
      detail: { expires_in_minutes: 60 },
    });
    expect(result.probe.url).toBe('https://api-us.band.us/v2.1.0/get_profile');
    expect(paths).toEqual(['/v2.1.0/get_profile']);
    expect(text).not.toContain('band_session');
  });

  it('a session without a readable exp reports no expiry', async () => {
    const { result } = await run({
      cookies: async () => ({ band_session: 'opaque' }),
      responses: [{ result_code: 1, result_data: { user_no: 1 } }],
    });
    expect(result.credential.detail).toEqual({});
  });

  it('an empty profile is a failure', async () => {
    const { result } = await run({ responses: [{ result_code: 1, result_data: null }] });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/no profile/);
  });

  it('not signed in → no_credential with the sign-in hint, no probe', async () => {
    const { result, paths } = await run({ getKey: async (t) => getKeyBody({ t, state: 'GUEST' }) });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('no_credential');
    expect(result.hint).toContain('https://www.band.us/');
    expect(paths).toHaveLength(0);
  });

  it('a hinted fetchproxy error keeps its own remedy', async () => {
    const { result } = await run({
      cookies: async () => {
        throw Object.assign(new Error('pairing required'), { name: 'FetchproxySessionNotReadyError', hint: 'Approve pair code 1.' });
      },
    });
    expect(result.error?.kind).toBe('bridge');
    expect(result.error?.detail).toEqual({ error: 'FetchproxySessionNotReadyError' });
    expect(result.hint).toBe('Approve pair code 1.');
  });

  it('an unclassified bridge failure → bridge arm', async () => {
    const { result } = await run({
      cookies: async () => {
        throw new Error('socket hang up');
      },
    });
    expect(result.error?.kind).toBe('bridge');
    expect(result.hint).toContain('ContextMint Bridge');
  });

  it('other probe failures fall through to the library arms', async () => {
    const { result } = await run({ responses: [{ result_code: 251, result_data: {} }] });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('http');
  });
});
