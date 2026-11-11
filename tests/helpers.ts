import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { API_BASE, BandClient } from '../src/client.js';
// Shared test fixtures. No real credential: fake JWTs are unsigned base64url
// JSON with a dummy signature segment, and the secret is made up.

export const NOW_MS = 1_800_000_000_000;
export const NOW = NOW_MS / 1000;

/** A made-up base64url signing secret. */
export const SECRET = Buffer.from('fake-signing-secret-0123456789ab').toString('base64url');

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

/** A band_session JWT expiring `secondsLeft` after NOW. */
export const bandSessionJwt = (secondsLeft = 2 * 86_400) => fakeJwt({ exp: NOW + secondsLeft, iat: NOW - 3600 });

/** A getKey JSONP body shaped like BAND's (values made up). */
export function getKeyBody(opts: { t?: number; secretKey?: string; isJwt?: boolean; timeCorrection?: number | null; state?: string } = {}): string {
  const t = opts.t ?? 1;
  const secretKey = opts.secretKey ?? SECRET;
  const isJwt = opts.isJwt ?? true;
  const state = opts.state ?? 'USER';
  const tc = opts.timeCorrection === null ? '' : `, timeCorrection: ${opts.timeCorrection ?? NOW_MS + 5000}`;
  return `authCallBack_${t}({ secretKey : '${secretKey}', isJwtType : ${isJwt}${tc}, authenticateState : "${state}" });`;
}

/** The error a promise rejects with (fails the test if it resolves). */
export async function rejectionOf<E = Error>(p: Promise<unknown>): Promise<E> {
  try {
    await p;
  } catch (err) {
    return err as E;
  }
  throw new Error('expected a rejection');
}

// ── tool harness ─────────────────────────────────────────────────────────────


/** A sanitized live response envelope from tests/fixtures (placeholder values only). */
export function fixture(name: string): { result_code: number; result_data: unknown } {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

/** A success envelope around `data`. */
export const ok = (data: unknown) => ({ result_code: 1, result_data: data });

export interface SentRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: string;
  /** The `md` signature header sent. */
  md?: string;
}

/**
 * A tool registrar wired to a BandClient whose fetch answers `script` in order
 * (an envelope object, or an Error to throw). Records every request sent.
 */
export async function toolHarness(
  register: (server: McpServer, client: BandClient) => void,
  script: unknown[],
  opts: { env?: Record<string, string | undefined>; now?: number } = {},
): Promise<{ harness: TestHarness; sent: SentRequest[]; client: BandClient; jwt: string }> {
  const jwt = bandSessionJwt();
  const queue = [...script];
  const sent: SentRequest[] = [];
  const client = new BandClient({
    readCookies: async () => ({ band_session: jwt, di: 'device-cookie-value' }),
    fetchGetKey: async (t) => getKeyBody({ t, timeCorrection: (opts.now ?? NOW_MS) }),
    now: () => opts.now ?? NOW_MS,
    env: opts.env ?? { MCP_USER_TZ: 'America/New_York' },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const u = new URL(String(url));
      expect(`${u.origin}`).toBe(API_BASE);
      const md = (init.headers as Record<string, string> | undefined)?.md;
      sent.push({
        method: String(init.method),
        path: u.pathname,
        query: u.searchParams,
        ...(init.body !== undefined ? { body: String(init.body) } : {}),
        ...(md !== undefined ? { md } : {}),
      });
      if (queue.length === 0) throw new Error('unexpected fetch');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const harness = await createTestHarness((server) => register(server, client));
  return { harness, sent, client, jwt };
}

/** The first text block of a tool result. */
export function textOf(result: CallToolResult): string {
  return (result.content as { text: string }[])[0]!.text;
}

/** The payload inside the untrusted-data envelope (asserting the fence is there). */
export function untrustedPayload<T = Record<string, unknown>>(result: CallToolResult): T {
  const parsed = JSON.parse(textOf(result)) as Record<string, unknown>;
  expect(parsed.untrusted_content).toBe(true);
  expect(typeof parsed.note).toBe('string');
  const { untrusted_content: _u, note: _n, ...rest } = parsed;
  return ('data' in rest && Object.keys(rest).length === 1 ? rest.data : rest) as T;
}
