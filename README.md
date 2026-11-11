# BAND MCP

[![CI](https://github.com/chrischall/band-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/band-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@chrischall/band-mcp)](https://www.npmjs.com/package/@chrischall/band-mcp)
[![license](https://img.shields.io/npm/l/@chrischall/band-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to [BAND](https://band.us), the group app teams, clubs, classes and families use. It reads your bands, posts, comments, notices, calendar events, members and chats. It can also write a post or a comment, and both writes are confirmation-gated.

> [!WARNING]
> **AI-developed project.** [Claude](https://www.anthropic.com/claude) built this codebase and maintains it. No human has audited the implementation. Review all code and tool permissions before use.

> [!CAUTION]
> **Unofficial and unsupported.** BAND has no public API for this. The server calls the internal API the band.us web app uses, authenticated with your own signed-in browser session. It may break without notice, and automated use may conflict with BAND's terms. Use it only for your own account, at your own discretion.

## What you can do

Ask Claude things like:

- *"What's new in my BAND groups?"*
- *"What's on the team band's calendar for the next month?"*
- *"Summarize the comments on the latest announcement."*
- *"Who in the band hasn't been online lately?"*
- *"Post a reminder to the band that practice moves to 6pm on Thursday."*

## Requirements

- [Claude Desktop](https://claude.ai/download), Claude Code, or any MCP host
- [Node.js](https://nodejs.org) 22.5 or later
- The [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) browser extension and a signed-in `https://www.band.us/` tab

## Installation

### Claude Code plugin

```bash
claude plugin marketplace add chrischall/band-mcp
claude plugin install band@chrischall
```

The plugin also installs the [`band` skill](skills/band/SKILL.md), which teaches Claude the workflow and the confirmation flow.

### Any MCP host (npx)

```json
{
  "mcpServers": {
    "band": {
      "command": "npx",
      "args": ["-y", "@chrischall/band-mcp"],
      "env": { "MCP_USER_TZ": "America/New_York" }
    }
  }
}
```

### Claude Desktop (.mcpb)

Install the `.mcpb` bundle from the [latest release](https://github.com/chrischall/band-mcp/releases). Its optional settings (time zone, write confirmation mode, confirmation prompts, debug logging, bridge port) set the environment variables in [Configuration](#configuration); leave them blank for the defaults.

## How it signs in

BAND's web API needs two things that only your browser has: the band.us session cookies, and a per-session signing key that BAND only hands to the web page. Fetched from anywhere else, the signing key comes back empty. This server uses the [fetchproxy](https://github.com/chrischall/fetchproxy) bridge (ContextMint Bridge) to:

1. read the band.us session cookies (the session token and five companion cookies, listed in [`docs/BAND-API.md`](docs/BAND-API.md)) from your signed-in tab, and
2. fetch the signing key through that tab.

Every API call is then made straight from Node to `https://api-us.band.us`, signed with an HMAC of the request URL. The cookies and key stay in memory only. They never appear in an error, a result or a log. The only thing written under your home directory is the bridge's pairing identity. The server never sees or stores your password.

The band.us session lasts a few days. The server reads it again from your tab when it is within 10 minutes of expiry. It also does so once if BAND answers "not authorized", with one re-read and one retry per call. The server never refreshes the session itself, because rotating the token from outside the browser could sign the browser out. If calls start failing, open or reload `https://www.band.us/` and sign in. The browser renews the session. `band_healthcheck` shows how many minutes the session has left, but never a cookie value.

### Pairing (once)

1. Install [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases) and sign in to `https://www.band.us/` in that browser.
2. Ask Claude to run `band_healthcheck`. The first call answers with a **pair code**.
3. Approve that code in the ContextMint Bridge popup. The trust persists across restarts in `~/.fetchproxy/identity/`.

**More than one browser?** Approve the code in the browser that holds your band.us session. The server pins whichever extension approved it. You may see stderr lines like `refusing an extension whose identity is not the one this MCP paired with`. Those come from the *other* browser being turned away, and they are harmless.

**Paired the wrong browser?** Revoke `band-mcp` in the ContextMint Bridge popup. Then run `fpx trust clear band-mcp` (from [`@fetchproxy/cli`](https://www.npmjs.com/package/@fetchproxy/cli)), restart the server, and pair again.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BAND_WS_PORT` | `37149` | The fetchproxy bridge port. The whole fetchproxy fleet and ContextMint Bridge share `37149`. Override it only for local testing, or when a host injects a per-registration port. |
| `MCP_USER_TZ` | the system zone | Your IANA time zone, for example `America/New_York`. It is sent to BAND as the device time zone and used for "today" in `band_list_events`. Set it when hosted, because a hosted server runs in UTC. |
| `BAND_DEBUG` | off | Log the bridge's role and lifecycle to stderr. |
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt. See below. |
| `MCP_CONFIRM_ELICITATION` | `on` | `off` never shows a confirmation prompt, so every client takes the `MCP_CONFIRM_MODE` path. Use it for clients that declare prompts but never render them. |

## Confirming writes

`band_create_post` and `band_create_comment` are confirmation-gated:

- **Clients that support MCP elicitation** show a real confirmation prompt that names the band and shows the text.
- **Other clients (claude.ai, Claude Desktop)** make **no** change on the first call. It returns a preview plus a single-use, short-lived `confirmToken`. Only a repeat call carrying that token writes. If anything in the request changed in between, or the browser is now signed in to a different BAND account, the token is refused.

`MCP_CONFIRM_MODE` decides who may use that token:

| Value | Behaviour |
|---|---|
| `ask-user` (default) | The model must show you the preview and get your approval in chat before reusing the token. |
| `auto` | The model may use the token itself after seeing the preview. |
| `refuse` | Writes are refused on clients without a confirmation prompt. An unrecognised value is treated as `refuse`. |

BAND members write the posts, comments, names and chat messages that come back from BAND. That text is treated as untrusted data and can never authorise a write.

## Tools

Read tools take `view: compact | full` (default `compact`). `compact` keeps what you need to browse. `full` keeps every field BAND sent. Times are ISO 8601. Paged tools return `next_cursor`, which you pass back as `cursor`.

| Tool | What it does |
|---|---|
| `band_healthcheck` | Check the BAND session: whether the browser session is readable, minutes until it expires, and whether BAND's API accepts it. |
| `band_whats_new` | Counts of new feed posts, unread chat messages and news across all your bands. |
| `band_list_bands` | List the bands (groups) you belong to, with their number, name and member count. |
| `band_get_band` | One band's details: type, open/secret, member count, leader, link, chat on/off. |
| `band_list_members` | List a band's members with role, online state and join date; optional name filter. |
| `band_list_posts` | Read a band's feed — posts and announcements — newest first, with paging. |
| `band_get_post` | Read one post in full, with its comments by default. |
| `band_list_comments` | List the comments on one post, with paging. |
| `band_list_notices` | List a band's notices (posts pinned as important). |
| `band_search_posts` | Search a band's posts by keyword. |
| `band_list_events` | List a band's calendar events between two dates (default the next 60 days). |
| `band_get_event` | Read one calendar event. |
| `band_list_chats` | List a band's chat channels with unread counts and latest message. |
| `band_get_chat` | Read one chat channel: participants, unread state and latest message (no history). |
| `band_create_post` | Write a new post to a band (confirm-gated: preview first, then post). |
| `band_create_comment` | Comment on a band post (confirm-gated: preview first, then comment). |

## Limits

- **No chat history.** BAND's web API exposes only each chat channel's latest message, so `band_get_chat` cannot read older messages.
- **No RSVP.** Answering an event (attend, decline, maybe) is out of scope. Editing or deleting posts and comments, photos, albums, polls and sending chat messages are also out of scope. The only writes are a new post and a new comment.
- **US API host only.** Every call goes to `api-us.band.us`, the host the web app uses for US accounts.

## Shell access without the MCP

[`skills/band-fpx/`](skills/band-fpx/SKILL.md) is a standalone, read-only skill that reads the same data from a shell with the `fpx` CLI.

## Development

```bash
npm install
npm run build        # tsc → dist/, then esbuild → dist/bundle.js (the .mcpb entry)
npm test             # typecheck + vitest
npm run test:coverage
```

[`docs/BAND-API.md`](docs/BAND-API.md) describes the API this server is built on: hosts, the session bootstrap, request signing and every endpoint used.

## License

MIT
