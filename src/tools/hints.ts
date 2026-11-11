// Context-group hints, published on each tool as `_meta.mint` (the mcp-host
// context-groups contract, `mintHintSchema`). Inert data: a host that does not
// read them sees an extra `_meta` key and nothing else. The shape is fixed by
// the host's contract, so it is restated here rather than imported — this
// server takes no dependency on mcp-host.
//
// BAND is where teams, clubs, classes and families coordinate, so every tool
// sits in the `family` domain (the contract has no "social" group). `when`
// names THIS tool's own argument names (the host fills them), never values.
// `aliases` are lowercase, at most 8, each ≤ 40 chars.

export type MintIntent = 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'family';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

/** `_meta` for a BAND tool: every tool here is in the `family` domain. */
export function familyMeta(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): { mint: MintHint } {
  return { mint: { domain: 'family', intent, ...extra } };
}

/** A read of one record or a reference list. */
export const LOOKUP = familyMeta('lookup');
