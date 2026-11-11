import { describe, expect, it, vi } from 'vitest';
import type { FetchproxyServer, FetchproxyServerOpts } from '@chrischall/mcp-utils/fetchproxy';
import { rejectionOf } from './helpers.js';
import { BRIDGE_DOMAIN, GETKEY_ORIGIN, RELAY_TAB, SESSION_COOKIES, createBandBridge, getKeyUrl } from '../src/transport.js';

function fakeServer(cookies: string | Error = 'band_session=a.b.c', getKey: { status: number; body: string } | Error = { status: 200, body: 'ok' }) {
  return {
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    bridgeHealth: vi.fn(() => ({ port: 37_149 })),
    readCookies: vi.fn(async (_opts: unknown) => {
      if (cookies instanceof Error) throw cookies;
      return cookies;
    }),
    get: vi.fn(async (_url: string, _opts: unknown) => {
      if (getKey instanceof Error) throw getKey;
      return { ...getKey, url: _url };
    }),
    role: null,
  };
}

function bridgeWith(server: ReturnType<typeof fakeServer>, captured: FetchproxyServerOpts[] = []) {
  return createBandBridge({
    port: 41_000,
    version: '9.9.9',
    createServer: (opts) => {
      captured.push(opts);
      return server as unknown as FetchproxyServer;
    },
  });
}

describe('createBandBridge', () => {
  it('declares band.us and ONLY the six session cookies up front, on the configured port', async () => {
    const captured: FetchproxyServerOpts[] = [];
    const server = fakeServer();
    const bridge = bridgeWith(server, captured);
    await bridge.start();
    expect(server.listen).toHaveBeenCalledTimes(1);
    const opts = captured[0]!;
    expect(opts.serverName).toBe('band-mcp');
    expect(opts.version).toBe('9.9.9');
    expect(opts.port).toBe(41_000);
    expect(BRIDGE_DOMAIN).toBe('band.us');
    expect(opts.domains).toEqual(['band.us']);
    expect(SESSION_COOKIES).toEqual(['band_session', 'ai', 'as', 'di', 'BBC', 'language']);
    expect(opts.cookieKeys).toEqual([...SESSION_COOKIES]);
    expect(opts.capabilities).toContain('read_cookies');
    expect(opts.capabilities).toContain('fetch');
  });

  it('reads every session cookie from www.band.us in ONE bridge call, leaving out absent/empty ones', async () => {
    const server = fakeServer('band_session=h.p.s; ai=1; as=; di=d; other=x');
    const bridge = bridgeWith(server);
    await expect(bridge.readSessionCookies()).resolves.toEqual({ band_session: 'h.p.s', ai: '1', di: 'd' });
    expect(server.readCookies).toHaveBeenCalledTimes(1);
    expect(server.readCookies).toHaveBeenCalledWith({ domain: 'band.us', subdomain: 'www', keys: [...SESSION_COOKIES] });
  });

  it('fetches getKey THROUGH the signed-in www.band.us tab and returns the body', async () => {
    const server = fakeServer('', { status: 200, body: 'authCallBack_5({secretKey:"x"})' });
    const bridge = bridgeWith(server);
    await expect(bridge.fetchGetKey(5)).resolves.toBe('authCallBack_5({secretKey:"x"})');
    expect(server.get).toHaveBeenCalledWith(getKeyUrl(5), { viaTab: RELAY_TAB });
    expect(RELAY_TAB).toBe('https://www.band.us/');
  });

  it('getKeyUrl names the callback after _t (else BAND answers an empty body)', () => {
    expect(GETKEY_ORIGIN).toBe('https://auth.band.us');
    expect(getKeyUrl(123)).toBe('https://auth.band.us/s/login/getKey?_t=123&callback=authCallBack_123');
  });

  it('a non-200 getKey answer is an error naming only the status', async () => {
    const bridge = bridgeWith(fakeServer('', { status: 502, body: 'secret-ish body' }));
    const err = await rejectionOf<Error>(bridge.fetchGetKey(1));
    expect(err.message).toBe('getKey answered HTTP 502');
  });

  it('starts lazily (once) when reads arrive before start()', async () => {
    const server = fakeServer();
    const bridge = bridgeWith(server);
    await Promise.all([bridge.readSessionCookies(), bridge.fetchGetKey(1), bridge.start()]);
    expect(server.listen).toHaveBeenCalledTimes(1);
  });

  it('propagates bridge errors untouched', async () => {
    const err = Object.assign(new Error('pairing required'), { name: 'FetchproxySessionNotReadyError', hint: 'Approve the pair code.' });
    await expect(bridgeWith(fakeServer(err)).readSessionCookies()).rejects.toBe(err);
    await expect(bridgeWith(fakeServer('', err)).fetchGetKey(1)).rejects.toBe(err);
  });

  it('a failed start is retried by the next read, and close() only closes a started server', async () => {
    const server = fakeServer();
    server.listen.mockRejectedValueOnce(new Error('identity unreadable'));
    const bridge = bridgeWith(server);
    await expect(bridge.start()).rejects.toThrow('identity unreadable');
    await bridge.close();
    expect(server.close).not.toHaveBeenCalled();
    await expect(bridge.readSessionCookies()).resolves.toEqual({ band_session: 'a.b.c' });
    await bridge.close();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('close() before start is a no-op', async () => {
    const server = fakeServer();
    await bridgeWith(server).close();
    expect(server.close).not.toHaveBeenCalled();
  });
});
