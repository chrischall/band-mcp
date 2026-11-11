#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { BandClient } from './client.js';
import { readWsPort } from './config.js';
import { TOOL_REGISTRARS } from './tools/index.js';
import { createBandBridge } from './transport.js';
import { VERSION } from './version.js';

// The bridge only bootstraps the session: it lifts the band.us cookies and
// fetches the signing key through the signed-in www.band.us tab. Every API
// call is then a plain, signed Node fetch to api-us.band.us.
const bridge = createBandBridge({ port: readWsPort(), version: VERSION });
// start() loads the fetchproxy identity (no port bind — that is lazy). A
// failure is NOT fatal: the next read retries the start (and throws its error
// if it still fails), so the server still boots and answers tools/list.
await bridge.start().catch(() => {});

// Built ONCE, outside the registrars (runMcp builds a server per connection).
// Nothing here resolves a credential at boot (deferred-config-error pattern).
const client = new BandClient({
  readCookies: () => bridge.readSessionCookies(),
  fetchGetKey: (t) => bridge.fetchGetKey(t),
});

await runMcp({
  name: 'band-mcp',
  version: VERSION,
  deps: client,
  tools: [...TOOL_REGISTRARS],
  shutdown: { onSignal: () => bridge.close() },
  banner:
    '[band-mcp] Unofficial BAND (band.us) MCP. BAND has no public API for this; it uses the web app\'s internal one ' +
    'and may break or violate their ToS. Developed and maintained by AI (Claude). Use at your own discretion.',
});
