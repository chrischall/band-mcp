// BandClient — every BAND API call, made from Node with the lifted band.us
// cookies and an `md` HMAC signature (see sign.ts). BAND always answers HTTP 200
// with `{ result_code, result_data }`; `1` is success. `300` (not authorized:
// an expired session or a stale secretKey) invalidates the session, re-lifts it
// once and retries once — safe for a POST too, since BAND refused it. Any other
// code is a BandApiError with BAND's own message.
//
// No cookie or secret value ever leaves this module in an error.

import {
  McpToolError,
  WriteOutcomeUnknownError,
  isTimeoutError,
  messageOf,
  redactValues,
  resolveUserTimeZone,
  truncateErrorMessage,
  type EnvSource,
} from '@chrischall/mcp-utils';
import { BandSession, BandSessionError, WEB_ORIGIN, type BandSessionInfo } from './session.js';
import { signRequest, type QueryParams } from './sign.js';
import type { SessionCookies } from './transport.js';

export const API_BASE = 'https://api-us.band.us';
/** The band.us web app's static API key (public; shipped in its JS). */
export const AKEY = 'bbc59b0b5f7a1c6efe950f6236ccda35';

const SERVICE = 'BAND';
const DEFAULT_TIMEOUT_MS = 30_000;
const RENEW_HINT = `Open ${WEB_ORIGIN} in the browser running ContextMint Bridge so it renews the session, then retry.`;

/** A form value for a POST body. */
export type FormValue = string | number | boolean;

export interface BandClientOptions {
  /** Lift the band.us session cookies (the bridge). */
  readCookies: () => Promise<SessionCookies>;
  /** getKey's raw body, fetched through the signed-in tab (the bridge). */
  fetchGetKey: (t: number) => Promise<string>;
  /** Injectable fetch. The default is a receiver-safe wrapper around the global. */
  fetchImpl?: typeof fetch;
  /** Clock in ms (test seam). */
  now?: () => number;
  /** Where MCP_USER_TZ is read from. Defaults to process.env. */
  env?: EnvSource;
  timeoutMs?: number;
}

/** BAND answered a result_code other than 1 (and other than a recoverable 300). */
export class BandApiError extends McpToolError {
  readonly resultCode: number;
  constructor(message: string, resultCode: number, hint?: string) {
    super(message, { ...(hint ? { hint } : {}), kind: 'http' });
    this.name = 'BandApiError';
    this.resultCode = resultCode;
  }
}

function hintFor(code: number): string | undefined {
  if (code === 1000) return 'BAND says the item was deleted or not found (or you cannot see it). Check the band_no / post_no / id.';
  if (code === 200 || code === 251) return 'BAND reported a temporary/unknown error, which usually means a missing or malformed parameter.';
  return undefined;
}

/** The UTC offset of `timeZone` at `at`, in ms (BAND's DEVICE-TIME-ZONE-MS-OFFSET). */
export function tzOffsetMs(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(String(name));
  /* v8 ignore next -- current ICU spells UTC "GMT+00:00"; older ones say bare "GMT" */
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** Every secret value the given sessions hold: each cookie value and the signing key. */
function secretValues(sessions: readonly BandSessionInfo[]): string[] {
  return sessions.flatMap((s) => [s.secretKey, ...s.cookie.split('; ').map((pair) => pair.slice(pair.indexOf('=') + 1))]);
}

interface Envelope {
  result_code: number;
  result_data?: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as Envelope).result_code === 'number';
}

export class BandClient {
  readonly session: BandSession;
  private readonly fetchImpl: typeof fetch;
  /** Clock in ms (test seam); tools use it for "today". */
  readonly now: () => number;
  /** The user's IANA zone (MCP_USER_TZ, else the system zone); tools use it for "today". */
  readonly timeZone: string;
  private readonly timeoutMs: number;

  constructor(opts: BandClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeZone = resolveUserTimeZone({ env: opts.env }) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.session = new BandSession({ readCookies: opts.readCookies, fetchGetKey: opts.fetchGetKey, now: this.now });
  }

  /** A signed GET; resolves to `result_data`. */
  get<T = unknown>(endpoint: string, params: QueryParams = {}): Promise<T> {
    return this.redacting(() => this.call<T>('GET', endpoint, params, undefined));
  }

  /** A signed form POST (md over `path?ts=` only); resolves to `result_data`. */
  post<T = unknown>(endpoint: string, form: Record<string, FormValue>): Promise<T> {
    const body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)]))
      .toString()
      .replace(/'/g, '%27');
    return this.redacting(() => this.call<T>('POST', endpoint, {}, body));
  }

  /** Run `fn`, scrubbing every session secret out of anything it throws. */
  private async redacting<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      /* v8 ignore next -- every throw below is an Error */
      if (err instanceof Error) {
        const scrubbed = redactValues(err.message, secretValues(this.session.recent()), { minLength: 8 });
        if (scrubbed !== err.message) err.message = scrubbed;
      }
      throw err;
    }
  }

  private async call<T>(method: 'GET' | 'POST', endpoint: string, params: QueryParams, body: string | undefined): Promise<T> {
    let envelope = await this.send(method, endpoint, params, body, await this.session.get());
    if (envelope.result_code === 300) {
      this.session.invalidate();
      envelope = await this.send(method, endpoint, params, body, await this.session.get());
      if (envelope.result_code === 300) {
        this.session.invalidate();
        throw new BandSessionError('BAND rejected the session (result_code 300) even after re-reading it from the browser', RENEW_HINT);
      }
    }
    if (envelope.result_code !== 1) {
      const code = envelope.result_code;
      const data = envelope.result_data as { message?: unknown } | undefined;
      // Redact BEFORE truncating, so no half-secret straddles the cut.
      const message = typeof data?.message === 'string' ? redactValues(data.message, secretValues(this.session.recent()), { minLength: 8 }) : '';
      const upstream = message ? `: ${truncateErrorMessage(message, 300)}` : '';
      throw new BandApiError(`BAND API ${endpoint} failed (result_code ${code})${upstream}`, code, hintFor(code));
    }
    return envelope.result_data as T;
  }

  private async send(
    method: 'GET' | 'POST',
    endpoint: string,
    params: QueryParams,
    body: string | undefined,
    session: BandSessionInfo,
  ): Promise<Envelope> {
    const nowMs = this.now();
    const { pathAndQuery, md } = signRequest({
      endpoint,
      params,
      ts: nowMs + session.clockSkewMs,
      secretKey: session.secretKey,
      isJwt: session.isJwt,
    });
    const headers: Record<string, string> = {
      akey: AKEY,
      md,
      language: 'en',
      'DEVICE-TIME-ZONE-ID': this.timeZone,
      'DEVICE-TIME-ZONE-MS-OFFSET': String(tzOffsetMs(this.timeZone, new Date(nowMs))),
      cookie: session.cookie,
      origin: 'https://www.band.us',
      referer: WEB_ORIGIN,
      ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } : {}),
    };

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${API_BASE}${pathAndQuery}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      if (method === 'POST') {
        throw new WriteOutcomeUnknownError(SERVICE, method, {
          cause: err,
          ...(isTimeoutError(err) ? { timeoutMs: this.timeoutMs } : {}),
          hint: 'Re-read the post or its comments to check whether it landed before retrying.',
        });
      }
      throw new McpToolError(`Could not reach BAND: ${truncateErrorMessage(messageOf(err), 200)}`, {
        cause: err,
        kind: isTimeoutError(err) ? 'timeout' : 'transport',
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isEnvelope(parsed)) {
      throw new McpToolError(`BAND API ${endpoint} gave an unexpected answer (HTTP ${res.status}).`, { status: res.status, kind: 'http' });
    }
    return parsed;
  }
}
