#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { TOOL_REGISTRARS, type ToolDeps } from './tools/index.js';
import { VERSION } from './version.js';

// Built ONCE, outside the registrars (runMcp builds a server per connection).
// Nothing here resolves a credential at boot (deferred-config-error pattern):
// the server must boot and answer tools/list before any BAND session exists.
const deps: ToolDeps = {};

await runMcp({
  name: 'band-mcp',
  version: VERSION,
  deps,
  tools: [...TOOL_REGISTRARS],
  banner:
    '[band-mcp] Unofficial BAND (band.us) MCP. BAND has no public API for this; it uses the web app\'s internal one ' +
    'and may break or violate their ToS. Developed and maintained by AI (Claude). Use at your own discretion.',
});
