# band-mcp

Unofficial BAND (band.us) MCP (`@chrischall/band-mcp`): bands, posts,
comments, notices, calendar events, members and chats; writes are
`band_create_post` and `band_create_comment` only, both confirm-gated.
stdio transport, tool prefix `band_`.

## Commands

```bash
npm run build          # tsc → dist/, then esbuild → dist/bundle.js (the .mcpb entry, runs with NO node_modules)
npm test               # typecheck + vitest (server-boot spawns the built artifacts — build first)
npm run test:coverage  # 100% thresholds, run by CI
```

## How it talks to BAND (fetchproxy *bootstrap*)

- The bridge lifts the band.us session cookies and fetches the per-session
  signing key (`auth.band.us/s/login/getKey`) through the signed-in
  `https://www.band.us/` tab. getKey fetched from Node returns an EMPTY
  `secretKey`, so it must go through the tab. Every API call is then plain
  Node `fetch` to `https://api-us.band.us` with an `md` HMAC signature header.
- Never call `auth.band.us/_auth/refresh.jsonp` from Node: rotating the token
  could sign the browser out. The browser renews its own session.
- No cookie or secret value may appear in an error, result or log.

## Layout

- `src/tools/index.ts` — `TOOL_REGISTRARS`, the ONE registrar list.
  `src/index.ts` registers it and `tests/manifest-roster.test.ts` drives it. A
  new tool also needs a `manifest.json` `tools` entry and a README row (both
  tested), and `tests/server-boot.test.ts` `MIN_TOOLS` raised.
- `skills/band-fpx/` — the standalone fpx skill; independent of the server.

## Rules specific to this repo

- The repo is public: no real band names, member names or ids anywhere —
  fixtures use placeholder values.
- Out of scope, by decision: RSVP writes, and any write beyond create post /
  create comment. Chat history is not available on this API.
- Tests make no network calls.
