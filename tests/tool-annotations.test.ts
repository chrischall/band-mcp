/**
 * Truthful annotations and context-group hints on every tool, read off the
 * REGISTERED config (the wire), not a hand-kept list.
 */

import { describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { BandClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/index.js';

interface Listed {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown; title?: unknown };
  _meta?: { mint?: Record<string, unknown> };
}

async function listed(): Promise<Listed[]> {
  const client = new BandClient({
    readCookies: () => Promise.reject(new Error('offline')),
    fetchGetKey: () => Promise.reject(new Error('offline')),
    fetchImpl: () => Promise.reject(new Error('offline')),
  });
  const harness = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, client);
  });
  try {
    return (await harness.client.listTools()).tools as Listed[];
  } finally {
    await harness.close();
  }
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion (healthcheck has none). */
const EXPECTED_INTENT: Record<string, string> = {
  band_list_bands: 'lookup',
  band_get_band: 'lookup',
  band_list_members: 'lookup',
  band_list_posts: 'whats-new',
  band_get_post: 'lookup',
  band_list_comments: 'lookup',
  band_list_notices: 'whats-new',
  band_search_posts: 'lookup',
  band_list_events: 'whats-on',
  band_get_event: 'lookup',
  band_list_chats: 'lookup',
  band_get_chat: 'lookup',
  band_whats_new: 'whats-new',
};

describe('tool annotations', () => {
  it('registers the read surface', async () => {
    const names = (await listed()).map((t) => t.name).sort();
    expect(names).toEqual([...Object.keys(EXPECTED_INTENT), 'band_healthcheck'].sort());
  });

  it('every tool: explicit readOnly + openWorld, a title, and a description', async () => {
    for (const t of await listed()) {
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe('boolean');
      expect(t.description?.length ?? 0, t.name).toBeGreaterThan(40);
      if (t.name !== 'band_healthcheck') {
        expect(t.annotations?.openWorldHint, t.name).toBe(true);
        expect(typeof t.annotations?.title, t.name).toBe('string');
      }
    }
  });

  it('every non-read sets destructiveHint explicitly; no read claims to destroy', async () => {
    for (const t of await listed()) {
      if (t.annotations?.readOnlyHint === false) expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
      else expect(t.annotations?.destructiveHint, t.name).not.toBe(true);
    }
  });

  it('publishes _meta.mint in the family domain with the expected intent and only contract keys', async () => {
    for (const t of await listed()) {
      if (t.name === 'band_healthcheck') continue;
      const mint = t._meta?.mint;
      expect(mint, t.name).toBeDefined();
      expect(DOMAINS).toContain(mint!.domain);
      expect(mint!.domain).toBe('family');
      expect(mint!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
      expect(Object.keys(mint!).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      const aliases = (mint!.aliases as string[] | undefined) ?? [];
      expect(aliases.length).toBeLessThanOrEqual(8);
      for (const a of aliases) {
        expect(a).toBe(a.toLowerCase());
        expect(a.length).toBeLessThanOrEqual(40);
      }
    }
  });

  it('band_list_events names its own date arguments in `when`', async () => {
    const t = (await listed()).find((x) => x.name === 'band_list_events')!;
    expect(t._meta?.mint?.when).toEqual({ start: 'from', end: 'to' });
  });
});
