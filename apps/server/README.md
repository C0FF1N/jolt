# jolt-mcp

The MCP server for **[Jolt](https://github.com/C0FF1N/jolt)**: it lets Claude Code, VS Code (Copilot agent mode),
Cursor, Windsurf and other [MCP](https://modelcontextprotocol.io) clients drive **one browser tab you choose**, quickly
and visibly, through the Jolt Chrome extension. Everything stays on your computer (loopback only).

## Use it

1. Install the **Jolt** extension from the Chrome Web Store (or load it unpacked from the
   [releases](https://github.com/C0FF1N/jolt/releases)).
2. Register this server with your MCP client:

   ```bash
   # Claude Code (all your projects)
   claude mcp add --scope user jolt -- npx -y jolt-mcp

   # Claude Code on native Windows needs the cmd /c wrapper for npx servers
   claude mcp add --scope user jolt -- cmd /c npx -y jolt-mcp
   ```

   VS Code (`.vscode/mcp.json` or your user `mcp.json`):

   ```json
   { "servers": { "jolt": { "type": "stdio", "command": "npx", "args": ["-y", "jolt-mcp"] } } }
   ```

   Any other client: command `npx`, args `-y jolt-mcp`.
3. Open the page you want automated, click the Jolt icon and press **Connect this tab**.

Requires Node 22 or newer. Several clients can run at once; each server takes the first free port in 9470-9480 and the
extension finds them all.

## Settings (environment variables)

| Variable | Effect |
|---|---|
| `JOLT_PORT` | Pin the server to exactly this port (no fallback). |
| `JOLT_BASE_PORT` | Start the 11-port range here instead of 9470. |
| `JOLT_CONNECT_GRACE_MS` | How long a tool call waits for the extension to reconnect (default 4000, `0` = fail at once). |
| `JOLT_MAX_SNAPSHOT_CHARS` | Cap on snapshot size (default 200000, `0` = unlimited). |
| `JOLT_TRACE=1` | Timing/size trace on stderr (never page content). |

The older `BROWSERMCP_*` names still work.

## Tools

`browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_snapshot`, `browser_click`, `browser_hover`,
`browser_type`, `browser_select_option`, `browser_press_key`, `browser_wait`, `browser_wait_for`,
`browser_get_console_logs`, `browser_screenshot`, and `browser_batch` (several actions in one call).

## More

Documentation, security model and source: <https://github.com/C0FF1N/jolt>.
Licensed under Apache-2.0. Derived from the [Browser MCP](https://github.com/browsermcp/mcp) server; Jolt is not
affiliated with or endorsed by that project (see `NOTICE`).
