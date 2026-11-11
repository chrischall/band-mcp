// The BAND session: the band.us cookies lifted from the signed-in tab, plus the
// per-session signing key from `auth.band.us/s/login/getKey` (fetched THROUGH
// the tab — from Node it answers an empty secretKey). Both are lifted together,
// single-flight, and cached in memory. `band_session` is a JWT living ~2–3
// days; we re-lift when within RELIFT_SKEW_SECONDS of its `exp`, or after the
// client invalidates the session (a result_code 300).
//
// We never call auth.band.us `/_auth/refresh.jsonp`: rotating the token from
// Node could sign the browser out. The browser renews its own session when the
// user visits band.us. No cookie or secret value ever appears in an error.

import {
  McpToolError,
  SessionNotAuthenticatedError,
  decodeJwtClaim,
  messageOf,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';
import { SESSION_COOKIES, type SessionCookies } from './transport.js';

export const WEB_ORIGIN = 'https://www.band.us/';

/** Re-lift this many seconds before the band_session `exp`. */
export const RELIFT_SKEW_SECONDS = 600;

export interface BandSessionInfo {
  /** `band_session=…; ai=…` — a secret. Never put it in a message, result or log. */
  cookie: string;
  /** The HMAC signing secret. A secret, like `cookie`. */
  secretKey: string;
  /** getKey's `isJwtType`: base64url-decode the secret for the HMAC key. */
  isJwt: boolean;
  /** Server time minus local time at the lift, in ms; added to every `ts`. */
  clockSkewMs: number;
  /** band_session `exp`, epoch seconds, when readable. */
  exp?: number;
}

export function signInHint(): string {
  return `Open and sign in to ${WEB_ORIGIN} in the browser running ContextMint Bridge, then retry.`;
}

/** No usable session in the browser. */
export class BandSessionError extends SessionNotAuthenticatedError {
  constructor(reason: string, hint: string = signInHint()) {
    super('BAND', WEB_ORIGIN);
    this.message = `Not signed in to BAND: ${reason}.`;
    Object.defineProperty(this, 'hint', { value: hint, enumerable: true, configurable: true });
  }
}

/** Reading through the bridge failed for an unclassified reason. */
export class BandBridgeError extends McpToolError {
  constructor(message: string, cause: unknown) {
    super(message, { hint: signInHint(), cause });
    this.name = 'BandBridgeError';
  }
}

/**
 * The fleet's `fetchproxyHintOf` rule: a `Fetchproxy*` error carrying a typed
 * hint (pairing pending, no tab, bridge down) already names its remedy, so it is
 * surfaced unmodified. Duck-typed — a duplicated package breaks `instanceof`.
 */
export function isHintedFetchproxyError(err: unknown): boolean {
  if (!(err instanceof Error) || !err.name.startsWith('Fetchproxy')) return false;
  const hint = (err as Error & { hint?: unknown }).hint;
  return typeof hint === 'string' && hint.length > 0;
}

export interface ParsedGetKey {
  secretKey?: string;
  isJwt: boolean;
  timeCorrection?: number;
  state?: string;
}

/** Parse getKey's JSONP body (it is JavaScript, not JSON). */
export function parseGetKey(body: string): ParsedGetKey {
  const secretKey = /secretKey\s*:\s*'([^']*)'/.exec(body)?.[1];
  const tc = /timeCorrection\s*:\s*(\d+)/.exec(body)?.[1];
  const state = /authenticateState\s*:\s*"(\w+)"/.exec(body)?.[1];
  return {
    ...(secretKey !== undefined ? { secretKey } : {}),
    isJwt: /isJwtType\s*:\s*true/.test(body),
    ...(tc !== undefined ? { timeCorrection: Number(tc) } : {}),
    ...(state !== undefined ? { state } : {}),
  };
}

export interface BandSessionOptions {
  /** Lift the band.us session cookies (one bridge call). */
  readCookies: () => Promise<SessionCookies>;
  /** getKey's raw body for timestamp `t`, fetched through the signed-in tab. */
  fetchGetKey: (t: number) => Promise<string>;
  /** Clock in ms (test seam). */
  now?: () => number;
}

export class BandSession {
  private cached: BandSessionInfo | undefined;
  private inflight: Promise<BandSessionInfo> | undefined;
  private readonly now: () => number;
  private lifts = 0;
  private history: BandSessionInfo[] = [];

  constructor(private readonly opts: BandSessionOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** A usable session, lifting one if none is cached or it is near expiry. */
  get(): Promise<BandSessionInfo> {
    const cached = this.cached;
    if (cached && (cached.exp === undefined || cached.exp - this.now() / 1000 > RELIFT_SKEW_SECONDS)) {
      return Promise.resolve(cached);
    }
    this.inflight ??= this.lift().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The cached session, without lifting. */
  peek(): BandSessionInfo | undefined {
    return this.cached;
  }

  /** How many lifts have completed (compare across a call to tell a fresh lift). */
  get generation(): number {
    return this.lifts;
  }

  /** The two most recent sessions (kept past invalidate()), for redaction only. */
  recent(): readonly BandSessionInfo[] {
    return this.history;
  }

  /** Drop the cached session (BAND rejected it); the next get() re-lifts. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async bridged<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isHintedFetchproxyError(err)) throw err;
      throw new BandBridgeError(`Could not read ${what} from the browser: ${truncateErrorMessage(messageOf(err), 200)}`, err);
    }
  }

  private async lift(): Promise<BandSessionInfo> {
    this.cached = undefined;
    const cookies = await this.bridged('the BAND session', () => this.opts.readCookies());
    const jwt = cookies['band_session'];
    if (!jwt) throw new BandSessionError(`no BAND session cookie was found for ${WEB_ORIGIN}`);

    const expClaim = decodeJwtClaim(jwt, 'exp');
    const exp = typeof expClaim === 'number' ? expClaim : undefined;
    if (exp !== undefined && exp <= this.now() / 1000) {
      throw new BandSessionError('the BAND session in the browser has expired');
    }

    const body = await this.bridged("BAND's signing key", () => this.opts.fetchGetKey(this.now()));
    if (!body.trim()) throw new BandSessionError("BAND's key service returned an empty answer");
    const parsed = parseGetKey(body);
    if (parsed.state !== 'USER') throw new BandSessionError('the band.us tab is not signed in');
    if (!parsed.secretKey) throw new BandSessionError('BAND did not issue a signing key for this session');

    const cookie = SESSION_COOKIES.filter((name) => cookies[name]).map((name) => `${name}=${cookies[name]}`).join('; ');
    const info: BandSessionInfo = {
      cookie,
      secretKey: parsed.secretKey,
      isJwt: parsed.isJwt,
      clockSkewMs: parsed.timeCorrection !== undefined ? parsed.timeCorrection - this.now() : 0,
      ...(exp !== undefined ? { exp } : {}),
    };
    this.cached = info;
    this.lifts++;
    this.history = [info, ...this.history].slice(0, 2);
    return info;
  }
}
