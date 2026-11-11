# band-mcp

Unofficial [BAND](https://band.us) MCP server for Claude — bands, posts,
comments, events, members and chats — developed and maintained by AI
(Claude Code).

> BAND has no public API for this. The server uses the web app's internal API
> through your signed-in browser session, so it may break without notice or
> conflict with BAND's terms. Use at your own discretion.

**Status: under construction.** No tools are registered yet.

## How it signs in

The server reads your band.us session through **ContextMint Bridge** (the
fetchproxy browser bridge) from a signed-in `https://www.band.us/` tab, then
calls BAND's API directly. It never sees or stores your password.

## Tools

| Tool | What it does |
|---|---|

## Shell access without the MCP

`skills/band-fpx/` is a standalone skill that reads the same data from a shell
with the `fpx` CLI.

## License

MIT
