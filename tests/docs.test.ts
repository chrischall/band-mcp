/**
 * The docs that ship with the package must stay in step with the code: the
 * MCP-usage skill names exactly the registered tools, the API notes cover
 * every endpoint the server calls, the README states the hard limits, and
 * every env var mint.yaml declares is documented in the README and server.json.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { BandClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/index.js';

const url = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(url(p), 'utf8');

const offlineClient = new BandClient({
  readCookies: () => Promise.reject(new Error('offline')),
  fetchGetKey: () => Promise.reject(new Error('offline')),
  fetchImpl: () => Promise.reject(new Error('offline')),
});

async function registeredNames(): Promise<string[]> {
  const harness = await createTestHarness((server) => {
    for (const register of TOOL_REGISTRARS) register(server, offlineClient);
  });
  try {
    return (await harness.listTools()).map((t) => t.name);
  } finally {
    await harness.close();
  }
}

/** Every `/vX.Y.Z/endpoint` literal in src/. */
function endpointsInSource(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(url(dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts')) {
        for (const m of read(rel).matchAll(/'(\/v\d+\.\d+\.\d+\/[a-z_]+)'/g)) found.add(m[1]);
      }
    }
  };
  walk('src');
  return [...found].sort();
}

describe('skills/band/SKILL.md (the MCP-usage skill)', () => {
  const path = 'skills/band/SKILL.md';

  it('exists with name + description frontmatter', () => {
    expect(existsSync(url(path))).toBe(true);
    const text = read(path);
    expect(text).toMatch(/^---\nname: band\ndescription: .+\n---\n/);
  });

  it('names every registered tool, and no tool that is not registered', async () => {
    const text = read(path);
    const registered = await registeredNames();
    expect(registered.filter((n) => !text.includes(`\`${n}\``))).toEqual([]);
    // `band_no` is the one argument name the skill must spell out; every other
    // `band_`-prefixed identifier counts as a tool name.
    const mentioned = new Set((text.match(/\bband_[a-z_]+\b/g) ?? []).filter((n) => n !== 'band_no'));
    expect([...mentioned].filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('explains the confirmation flow and the out-of-scope writes', () => {
    const text = read(path);
    expect(text).toMatch(/confirmToken/);
    expect(text).toMatch(/RSVP/);
    expect(text).toMatch(/chat history/i);
  });
});

describe('docs/BAND-API.md', () => {
  it('documents every endpoint the server calls', () => {
    const doc = read('docs/BAND-API.md');
    const endpoints = endpointsInSource();
    expect(endpoints.length).toBeGreaterThan(10);
    expect(endpoints.filter((e) => !doc.includes(e))).toEqual([]);
  });

  it('documents the md signature and the getKey bootstrap', () => {
    const doc = read('docs/BAND-API.md');
    expect(doc).toMatch(/HMAC-SHA256/);
    expect(doc).toMatch(/getKey/);
    expect(doc).toMatch(/result_code/);
  });
});

describe('README', () => {
  it('states the hard limits: chat history, RSVP, the US API host', () => {
    const readme = read('README.md');
    expect(readme).toMatch(/chat history/i);
    expect(readme).toMatch(/RSVP/);
    expect(readme).toMatch(/api-us\.band\.us/);
    expect(readme).not.toMatch(/under construction/i);
  });

  it('links the skill and the API notes', () => {
    const readme = read('README.md');
    expect(readme).toContain('skills/band/');
    expect(readme).toContain('docs/BAND-API.md');
  });
});

describe('env var docs', () => {
  const mintEnv = [...read('mint.yaml').matchAll(/^ {2}- name: ([A-Z_]+)$/gm)].map((m) => m[1]);

  it('mint.yaml declares the env the server reads', () => {
    expect(mintEnv).toEqual(expect.arrayContaining(['BAND_WS_PORT', 'MCP_USER_TZ', 'BAND_DEBUG']));
  });

  it('the README configuration table names every mint.yaml env var', () => {
    const readme = read('README.md');
    expect(mintEnv.filter((n) => !readme.includes(`\`${n}\``))).toEqual([]);
  });

  it('server.json declares every mint.yaml env var', () => {
    const server = JSON.parse(read('server.json')) as {
      packages: { environmentVariables: { name: string; description: string }[] }[];
    };
    const declared = server.packages[0].environmentVariables.map((e) => e.name);
    expect(mintEnv.filter((n) => !declared.includes(n))).toEqual([]);
  });

  it('mint.yaml carries an example for reading and for each write', () => {
    const mint = read('mint.yaml');
    const examples = mint.match(/^ {2}- prompt: /gm) ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(4);
    expect(mint).toMatch(/- prompt: .*\bpost\b/i);
    expect(mint).toMatch(/- prompt: .*\bcomment\b/i);
  });
});
