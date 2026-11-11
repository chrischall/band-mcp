# band-mcp

Unofficial [BAND](https://band.us) MCP server for Claude — bands, posts,
comments, events, members and chats — developed and maintained by AI
(Claude Code).

> BAND has no public API for this. The server uses the web app's internal API
> through your signed-in browser session, so it may break without notice or
> conflict with BAND's terms. Use at your own discretion.

**Status: under construction.** Read tools are in; writes are coming.

## How it signs in

The server reads your band.us session through **ContextMint Bridge** (the
fetchproxy browser bridge) from a signed-in `https://www.band.us/` tab, then
calls BAND's API directly. It never sees or stores your password.

## Tools

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

## Shell access without the MCP

`skills/band-fpx/` is a standalone skill that reads the same data from a shell
with the `fpx` CLI.

## License

MIT
