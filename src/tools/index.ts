// The one list of tool registrars. `src/index.ts` registers exactly these, and
// the manifest-roster and annotation tests drive the same list, so a registrar
// can never be wired into the server but missed by the tests (or vice versa).

import type { McpServer } from '@modelcontextprotocol/server';
import type { BandClient } from '../client.js';
import { registerBandTools } from './bands.js';
import { registerChatTools } from './chats.js';
import { registerEventTools } from './events.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { registerNewsTools } from './news.js';
import { registerPostTools } from './posts.js';
import { registerWriteTools } from './writes.js';

/** The dependency every registrar receives: the signed BAND API client. */
export type ToolDeps = BandClient;

export type ToolRegistrar = (server: McpServer, client: ToolDeps) => void;

export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerHealthcheckTool,
  registerNewsTools,
  registerBandTools,
  registerPostTools,
  registerEventTools,
  registerChatTools,
  registerWriteTools,
];
