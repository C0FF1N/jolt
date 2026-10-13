# Local development

Requirements: Node ≥ 22 (tested on 24.14), pnpm 11 (via corepack), Windows/macOS/Linux. Chrome or Chromium for the
extension. No hosted service is needed for any core operation.

## Install, build, test

```bash
pnpm install          # allowBuilds in pnpm-workspace.yaml lets esbuild run its install script
pnpm -r build         # builds: baseline, apps/server, apps/extension
pnpm -r typecheck     # tsc --noEmit in apps/server, apps/extension and baseline
pnpm test             # vitest: unit + compatibility + protocol e2e (builds must exist first)
```

Build outputs:

| Artifact | Path |
|---|---|
| MCP server (turbo) | `apps/server/dist/index.js` (bin `mcp-server-browsermcp`) |
| MCP server (upstream baseline, for A/B) | `baseline/dist/index.js` |
| **Chrome extension (load this folder)** | `apps/extension/dist/` (`manifest.json`, `background.js`, `popup.html`, `popup.js`) |

`pnpm -r build` runs each package's `build`: `tsup` for the servers, `node build.mjs` (esbuild) for the extension.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `apps/extension/dist` folder.
4. Pin "Browser MCP Turbo (unofficial)" if you like.
5. After rebuilding, click the reload icon on the extension card.

Connect a tab: open the page you want automated → click the extension icon → **Connect this tab**. Chrome shows a
"started debugging this browser" banner; that is `chrome.debugger` and is expected. Dismissing it disconnects.

> Branded Chrome 137+ ignores the `--load-extension` command-line switch, so use the steps above (or a
> Chromium/Chrome for Testing build) rather than a flag. The benchmark scripts use Playwright's Chromium.

## Run the server / configure MCP clients

The server speaks MCP over stdio and listens for the extension on `ws://127.0.0.1:9009`
(`BROWSERMCP_PORT` to change). Use an absolute path to the built file; `<REPO>` below is your checkout:

```bash
node <REPO>/apps/server/dist/index.js
```

| Client | Where / how | Entry |
|---|---|---|
| Claude Code | `claude mcp add browsermcp-turbo -- node <REPO>/apps/server/dist/index.js` | stdio command |
| Claude Desktop, Cursor, Windsurf | their MCP config JSON (`claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`) | `{"mcpServers":{"browsermcp-turbo":{"command":"node","args":["<REPO>/apps/server/dist/index.js"]}}}` |
| VS Code | `.vscode/mcp.json` | `{"servers":{"browsermcp-turbo":{"type":"stdio","command":"node","args":["<REPO>/apps/server/dist/index.js"]}}}` |

These shapes follow each client's documented format; only Claude Code's `mcpServers` stdio shape was observed on
the development machine. Use a **different server name** than an existing `browsermcp` entry so you do not
overwrite it. If the original Browser MCP server is also running it owns port 9009: start this one with
`BROWSERMCP_PORT=9010` in its `env` and connect the extension to 9010 (see below).

### Choosing a port for the new extension

The popup has a **Server port** field (default 9009, remembered). Set it to the same value as the server's
`BROWSERMCP_PORT` before pressing *Connect this tab*. The port must be 1024–65535 and the host is always `127.0.0.1`.

## Diagnostics

```bash
BROWSERMCP_TRACE=1 node apps/server/dist/index.js            # JSON lines on stderr
BROWSERMCP_TRACE=1 BROWSERMCP_TRACE_FILE=trace.jsonl …       # or to a file
```

Events: `mcp.received`, `mcp.completed` (tool, duration, response bytes, isError), `ws.send` / `ws.response`
(type, request id, bytes, duration), `ws.timeout`, `ws.hello`, `ws.drop_*`. Each tool call gets a `traceId` so its
WebSocket events correlate. **Only sizes, types and timings are logged**: no payloads, URLs, page text, form values
or cookies. Disabled by default; the disabled path is a single boolean check.

Other environment variables: `BROWSERMCP_PORT`, `BROWSERMCP_MAX_SNAPSHOT_CHARS` (0 = unlimited),
`BROWSERMCP_SEQUENTIAL_SNAPSHOT=1`, `BROWSERMCP_KILL_PORT_HOLDER=1`.

## Benchmarks

See [performance-benchmarks.md](performance-benchmarks.md#reproduce). The real-browser scripts launch their own
Chromium with a throw-away profile; they never touch your Chrome profiles.

## Layout

```
apps/server      MCP server (copy of upstream src, modified)
apps/extension   new MV3 extension (TypeScript, esbuild)
baseline         unmodified upstream src, built against the same shims (A/B reference)
packages/*       @repo/* and @r2r/messaging reconstructed from the published bundle
bench            mock + real-browser harnesses, fixtures, compatibility/e2e tests, raw results
docs             this documentation; STATUS.md is the checkpoint
```

Licence: Apache-2.0 (upstream `LICENSE` retained). See `NOTICE` for attribution.
