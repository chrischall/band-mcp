// The ContextMint Bridge, used ONLY to bootstrap the session (the fleet's
// "bootstrap" archetype): it lifts the band.us session cookies and fetches the
// per-session signing key (`auth.band.us/s/login/getKey`) THROUGH the user's
// signed-in https://www.band.us/ tab. Fetched from Node, getKey answers a
// signed-in state with an EMPTY secretKey, so that one request must ride the
// tab. Every API call after that is a plain Node fetch — see client.ts.
//
// `@chrischall/mcp-utils/fetchproxy` eagerly imports `@fetchproxy/server`, so it
// is imported lazily here (type imports are erased): nothing on the boot path
// depends on the bridge package resolving.

import { parseCookieHeader } from '@chrischall/mcp-utils';
import type { FetchproxyServer, FetchproxyServerOpts, FetchproxyTransport, LazyTransport } from '@chrischall/mcp-utils/fetchproxy';

/** The cookie / fetch domain the bridge is scoped to (covers www., auth.). */
export const BRIDGE_DOMAIN = 'band.us';

/** The signed-in tab getKey is relayed through. */
export const RELAY_TAB = 'https://www.band.us/';

export const GETKEY_ORIGIN = 'https://auth.band.us';

/**
 * Every cookie this MCP reads, declared up front: the pair grant is per-scope,
 * so changing this list strands every paired user until they re-approve.
 * `band_session` is the session JWT; the rest ride along as BAND's web app sends them.
 */
export const SESSION_COOKIES: readonly string[] = ['band_session', 'ai', 'as', 'di', 'BBC', 'language'];

/** The session cookies the browser had, by name (absent or empty ones are left out). */
export type SessionCookies = Partial<Record<string, string>>;

/** The getKey URL. The JSONP callback MUST be `authCallBack_<_t>` or BAND answers an empty body. */
export function getKeyUrl(t: number): string {
  return `${GETKEY_ORIGIN}/s/login/getKey?_t=${t}&callback=authCallBack_${t}`;
}

export interface BandBridge {
  /** Load the fetchproxy identity (no port bind — that is lazy, on the first read). */
  start(): Promise<void>;
  close(): Promise<void>;
  /** The session cookies for www.band.us, in ONE bridge round-trip. */
  readSessionCookies(): Promise<SessionCookies>;
  /** The raw getKey JSONP body for timestamp `t`, fetched through the signed-in tab. */
  fetchGetKey(t: number): Promise<string>;
}

export interface BandBridgeOptions {
  port: number;
  version: string;
  /** Test seam: build the underlying FetchproxyServer (inject a mock). */
  createServer?: (opts: FetchproxyServerOpts) => FetchproxyServer;
}

export function createBandBridge(opts: BandBridgeOptions): BandBridge {
  // The library's build-once / start-once wrapper. `ready()` single-flights the
  // start and FORGETS a rejected one, so a start failure surfaces from the next
  // read instead of crashing boot — and that read retries it.
  let lazy: Promise<LazyTransport<FetchproxyTransport>> | undefined;
  let lastReady: Promise<FetchproxyTransport> | undefined;

  const lazyTransport = (): Promise<LazyTransport<FetchproxyTransport>> =>
    (lazy ??= import('@chrischall/mcp-utils/fetchproxy').then((fp) =>
      fp.createLazyTransport(() =>
        fp.createFetchproxyTransport({
          serverName: 'band-mcp',
          version: opts.version,
          port: opts.port,
          ...fp.createBootstrapOpts({
            domains: [BRIDGE_DOMAIN],
            bootstrap: { cookieKeys: [...SESSION_COOKIES] },
          }),
          debugEnvVar: 'BAND_DEBUG',
          logListening: true,
          createServer: opts.createServer,
        }),
      ),
    ));

  const ensureStarted = (): Promise<FetchproxyTransport> => (lastReady = lazyTransport().then((l) => l.ready()));

  return {
    async start() {
      await ensureStarted();
    },
    async close() {
      const transport = await lastReady?.catch(() => undefined);
      await transport?.close();
    },
    async readSessionCookies() {
      const transport = await ensureStarted();
      const header = await transport.server.readCookies({ domain: BRIDGE_DOMAIN, subdomain: 'www', keys: [...SESSION_COOKIES] });
      const parsed = parseCookieHeader(header);
      const out: SessionCookies = {};
      for (const name of SESSION_COOKIES) if (parsed[name]) out[name] = parsed[name];
      return out;
    },
    async fetchGetKey(t) {
      const transport = await ensureStarted();
      const res = await transport.server.get(getKeyUrl(t), { viaTab: RELAY_TAB });
      // Only the status: the body may carry the secret.
      if (res.status !== 200) throw new Error(`getKey answered HTTP ${res.status}`);
      return res.body;
    },
  };
}
