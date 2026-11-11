import { describe, expect, it, vi } from 'vitest';
import { McpToolError, SessionNotAuthenticatedError } from '@chrischall/mcp-utils';
import { BandBridgeError, BandSession, BandSessionError, RELIFT_SKEW_SECONDS, parseGetKey, signInHint } from '../src/session.js';
import type { SessionCookies } from '../src/transport.js';
import { NOW, NOW_MS, SECRET, bandSessionJwt, getKeyBody, rejectionOf } from './helpers.js';

function sessionWith(
  opts: {
    cookies?: () => Promise<SessionCookies>;
    getKey?: (t: number) => Promise<string>;
    now?: () => number;
  } = {},
) {
  const jwt = bandSessionJwt();
  const readCookies = vi.fn(opts.cookies ?? (async () => ({ band_session: jwt, ai: 'aa', BBC: 'bb' })));
  const fetchGetKey = vi.fn(opts.getKey ?? (async (t: number) => getKeyBody({ t })));
  const session = new BandSession({ readCookies, fetchGetKey, now: opts.now ?? (() => NOW_MS) });
  return { session, readCookies, fetchGetKey, jwt };
}

describe('parseGetKey', () => {
  it('reads secretKey, isJwtType, timeCorrection and authenticateState', () => {
    expect(parseGetKey(getKeyBody({ secretKey: 'abc', isJwt: false, timeCorrection: 42, state: 'USER' }))).toEqual({
      secretKey: 'abc',
      isJwt: false,
      timeCorrection: 42,
      state: 'USER',
    });
  });

  it('tolerates missing fields', () => {
    expect(parseGetKey('')).toEqual({ isJwt: false });
    expect(parseGetKey(getKeyBody({ timeCorrection: null, state: 'GUEST' }))).toEqual({ secretKey: SECRET, isJwt: true, state: 'GUEST' });
  });
});

describe('BandSession', () => {
  it('lifts cookies + getKey together and caches while outside the skew window', async () => {
    const { session, readCookies, fetchGetKey, jwt } = sessionWith();
    const info = await session.get();
    expect(info).toEqual({
      cookie: `band_session=${jwt}; ai=aa; BBC=bb`,
      secretKey: SECRET,
      isJwt: true,
      clockSkewMs: 5000,
      exp: NOW + 2 * 86_400,
    });
    await session.get();
    expect(readCookies).toHaveBeenCalledTimes(1);
    expect(fetchGetKey).toHaveBeenCalledTimes(1);
    expect(fetchGetKey).toHaveBeenCalledWith(NOW_MS);
    expect(session.peek()).toEqual(info);
  });

  it('a missing timeCorrection means zero skew', async () => {
    const { session } = sessionWith({ getKey: async () => getKeyBody({ timeCorrection: null }) });
    expect((await session.get()).clockSkewMs).toBe(0);
  });

  it('single-flights concurrent lifts', async () => {
    const { session, readCookies } = sessionWith();
    const [a, b] = await Promise.all([session.get(), session.get()]);
    expect(a).toBe(b);
    expect(readCookies).toHaveBeenCalledTimes(1);
  });

  it(`re-lifts within ${RELIFT_SKEW_SECONDS}s of the band_session exp`, async () => {
    expect(RELIFT_SKEW_SECONDS).toBe(600);
    let now = NOW_MS;
    const { session, readCookies } = sessionWith({ now: () => now });
    await session.get();
    now = (NOW + 2 * 86_400 - RELIFT_SKEW_SECONDS + 1) * 1000;
    await session.get().catch(() => undefined);
    expect(readCookies).toHaveBeenCalledTimes(2);
  });

  it('a band_session without a readable exp is cached until invalidated', async () => {
    const { session, readCookies } = sessionWith({ cookies: async () => ({ band_session: 'not-a-jwt' }) });
    const info = await session.get();
    expect(info.exp).toBeUndefined();
    await session.get();
    expect(readCookies).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces a re-lift; generation counts lifts; recent() keeps two for redaction', async () => {
    const { session, readCookies } = sessionWith();
    expect(session.generation).toBe(0);
    expect(session.recent()).toEqual([]);
    await session.get();
    session.invalidate();
    expect(session.peek()).toBeUndefined();
    await session.get();
    session.invalidate();
    await session.get();
    expect(readCookies).toHaveBeenCalledTimes(3);
    expect(session.generation).toBe(3);
    expect(session.recent()).toHaveLength(2);
  });

  it('no band_session cookie → BandSessionError with the sign-in hint, and getKey is not fetched', async () => {
    const { session, fetchGetKey } = sessionWith({ cookies: async () => ({ ai: 'aa' }) });
    const err = await rejectionOf<BandSessionError>(session.get());
    expect(err).toBeInstanceOf(BandSessionError);
    expect(err).toBeInstanceOf(SessionNotAuthenticatedError);
    expect(err.message).toMatch(/Not signed in to BAND/);
    expect(err.hint).toBe(signInHint());
    expect(err.hint).toContain('https://www.band.us/');
    expect(err.hint).toContain('ContextMint Bridge');
    expect(fetchGetKey).not.toHaveBeenCalled();
  });

  it('an expired band_session → BandSessionError', async () => {
    const { session } = sessionWith({ cookies: async () => ({ band_session: bandSessionJwt(-10) }) });
    await expect(session.get()).rejects.toThrow(/expired/);
  });

  it('a GUEST getKey → not signed in', async () => {
    const { session } = sessionWith({ getKey: async () => getKeyBody({ state: 'GUEST' }) });
    const err = await rejectionOf<BandSessionError>(session.get());
    expect(err).toBeInstanceOf(BandSessionError);
    expect(err.message).toMatch(/not signed in/);
  });

  it('a signed-in getKey with an EMPTY secret → session error (never cached)', async () => {
    const { session } = sessionWith({ getKey: async () => getKeyBody({ secretKey: '' }) });
    await expect(session.get()).rejects.toBeInstanceOf(BandSessionError);
    expect(session.peek()).toBeUndefined();
  });

  it('an empty getKey body → session error', async () => {
    const { session } = sessionWith({ getKey: async () => '' });
    const err = await rejectionOf<Error>(session.get());
    expect(err).toBeInstanceOf(BandSessionError);
    expect(err.message).toMatch(/empty/);
  });

  it('a hinted Fetchproxy* error passes through unmodified', async () => {
    const hinted = Object.assign(new Error('pair pending'), { name: 'FetchproxySessionNotReadyError', hint: 'Approve the code.' });
    const a = sessionWith({ cookies: async () => Promise.reject(hinted) });
    await expect(a.session.get()).rejects.toBe(hinted);
    const b = sessionWith({ getKey: async () => Promise.reject(hinted) });
    await expect(b.session.get()).rejects.toBe(hinted);
  });

  it('an unhinted bridge failure → BandBridgeError with the sign-in hint', async () => {
    for (const bad of [new Error('socket closed'), Object.assign(new Error('x'), { name: 'FetchproxyOther' })]) {
      const { session } = sessionWith({ cookies: async () => Promise.reject(bad) });
      const err = await rejectionOf<BandBridgeError>(session.get());
      expect(err).toBeInstanceOf(BandBridgeError);
      expect(err).toBeInstanceOf(McpToolError);
      expect(err.hint).toBe(signInHint());
    }
    const g = sessionWith({ getKey: async () => Promise.reject(new Error('getKey answered HTTP 502')) });
    await expect(g.session.get()).rejects.toThrow(/signing key.*HTTP 502/);
  });

  it('a failed lift is not cached: the next get() retries', async () => {
    const cookies = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ band_session: bandSessionJwt() });
    const { session } = sessionWith({ cookies });
    await expect(session.get()).rejects.toBeInstanceOf(BandBridgeError);
    await expect(session.get()).resolves.toMatchObject({ secretKey: SECRET });
  });

  it('never puts a cookie or secret value in an error', async () => {
    const jwt = bandSessionJwt(-10);
    const { session } = sessionWith({ cookies: async () => ({ band_session: jwt, ai: 'cookie-value-ai' }) });
    const err = await rejectionOf<BandSessionError>(session.get());
    const text = `${err.message} ${err.hint}`;
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('cookie-value-ai');
    const g = sessionWith({ getKey: async () => getKeyBody({ state: 'GUEST' }) });
    const gErr = await rejectionOf<BandSessionError>(g.session.get());
    expect(`${gErr.message} ${gErr.hint}`).not.toContain(SECRET);
  });

  it('defaults to the real clock', async () => {
    const session = new BandSession({
      readCookies: async () => ({ band_session: bandSessionJwt() }),
      fetchGetKey: async (t) => getKeyBody({ t, timeCorrection: null }),
    });
    await expect(session.get()).resolves.toMatchObject({ clockSkewMs: 0 });
  });
});
