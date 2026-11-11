// band_healthcheck — a CREDENTIAL healthcheck: the bridge only lifts the
// band.us session (cookies + signing key), then every call is direct from
// Node, so the useful questions are "is there a session, how long has it got,
// does the API accept it". Reports a source label and minutes-to-expiry,
// never the cookie or key.

import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import type { BandClient } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import { BandBridgeError, BandSessionError, isHintedFetchproxyError } from '../session.js';

const CREDENTIAL_SOURCE = 'browser session (ContextMint Bridge)';

function classify(err: unknown): { kind: string; hint?: string; detail?: Record<string, unknown> } | undefined {
  if (isHintedFetchproxyError(err)) {
    return { kind: 'bridge', hint: (err as McpToolError).hint, detail: { error: (err as Error).name } };
  }
  if (err instanceof BandBridgeError) return { kind: 'bridge', hint: err.hint };
  if (err instanceof BandSessionError) return { kind: 'no_credential', hint: err.hint };
  return undefined;
}

export function registerHealthcheckTool(server: McpServer, client: BandClient): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'band',
    hostLabel: 'api-us.band.us',
    probePath: ENDPOINTS.PROFILE,
    resolveCredential: async () => {
      const session = await client.session.get();
      return {
        source: CREDENTIAL_SOURCE,
        detail:
          session.exp !== undefined ? { expires_in_minutes: Math.floor((session.exp - client.now() / 1000) / 60) } : {},
      };
    },
    probeFn: async () => {
      const profile = await client.get<unknown>(ENDPOINTS.PROFILE);
      if (typeof profile !== 'object' || profile === null) {
        throw new McpToolError('BAND answered, but returned no profile for the signed-in user.');
      }
    },
    classifyThrown: classify,
  });
}
