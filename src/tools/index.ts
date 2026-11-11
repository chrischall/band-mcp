// The one list of tool registrars. `src/index.ts` registers exactly these, and
// the manifest-roster and annotation tests drive the same list, so a registrar
// can never be wired into the server but missed by the tests (or vice versa).

import type { McpServer } from '@modelcontextprotocol/server';

/**
 * The dependencies every registrar receives. A placeholder until the API
 * client lands; registrars take it as their second argument.
 */
export type ToolDeps = Record<string, never>;

export type ToolRegistrar = (server: McpServer, deps: ToolDeps) => void;

export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [];
