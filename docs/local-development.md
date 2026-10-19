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
| MCP server | `apps/server/dist/jolt-server.mjs` (single file, what npm ships; bin `jolt-mcp`) and `apps/server/dist/index.js` (dev/test build) |
| MCP server (upstream baseline, for A/B) | `baseline/dist/index.js` |
| **Chrome extension (load this folder)** | `apps/extension/dist/` (`manifest.json`, `background.js`, `popup.html`, `popup.css`, `popup.js`, `icons/`) |

`pnpm -r build` runs each package's `build`: `tsup` for the servers, `node build.mjs` (esbuild) for the extension.

## Load the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `apps/extension/dist` folder.
4. Pin "Jolt" to the toolbar. Its badge shows the state: **ON** (linked), **…** (waiting/reconnecting),
   **!** (problem), none (idle).
5. After rebuilding, click the reload icon on the extension card.

Connect a tab: open the page you want automated → click the extension icon → **Connect this tab**. Chrome shows a
"started debugging this browser" banner; that is `chrome.debugger` and is expected. Dismissing it disconnects.

> Branded Chrome 137+ ignores the `--load-extension` command-line switch, so use the steps above (or a
> Chromium/Chrome for Testing build) rather than a flag. The benchmark scripts use Playwright's Chromium.

## Run the server / configure MCP clients

**Shortcut:** `pnpm run setup` registers the built server with Claude Code (`claude mcp add --scope user`) and VS Code
(user-level `mcp.json`). `--dry-run` previews, `--claude` / `--vscode` limit it to one client, `--force` replaces an
existing entry, `--name=` changes the server name. Nothing is overwritten otherwise, VS Code's file is backed up first,
and a file it cannot parse safely is left alone (the snippet is printed for you to paste).

The server speaks MCP over stdio and listens for the extension on loopback. Each server instance takes the **first
free port in 9470-9480**, so Claude Code and VS Code (or two Claude Code sessions) can run side by side; the extension
finds every one of them. Use an absolute path to the built file; `<REPO>` below is your checkout:

```bash
node <REPO>/apps/server/dist/index.js
```

| Client | Where / how | Entry |
|---|---|---|
| Claude Code | `claude mcp add jolt -- node <REPO>/apps/server/dist/index.js` | stdio command |
| Claude Desktop, Cursor, Windsurf | their MCP config JSON (`claude_desktop_config.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`) | `{"mcpServers":{"jolt":{"command":"node","args":["<REPO>/apps/server/dist/index.js"]}}}` |
| VS Code | `.vscode/mcp.json` | `{"servers":{"jolt":{"type":"stdio","command":"node","args":["<REPO>/apps/server/dist/index.js"]}}}` |

These shapes follow each client's documented format; only Claude Code's `mcpServers` stdio shape was observed on
the development machine. Use a **different server name** than an existing `browsermcp` entry so you do not
overwrite it. The default range (9470-9480) deliberately avoids 9009, the original Browser MCP server's fixed port, so
both can run at once; the new extension never probes 9009.

### Ports and discovery

No port needs to be typed. When you press *Connect this tab* the extension asks each port in 9470-9480 who is there
(a plain HTTP `GET /info`, which returns the server name, the MCP client's name and whether a tab is already linked),
shows the clients it found, and connects to the one you pick (default: the one you used last, else the newest).
If none is running yet, "Connect and wait" arms the tab and it links the moment a server starts.

Why HTTP and not WebSockets for the scan: Chrome delays every new WebSocket connect by several seconds after a few
failed ones (its anti port-scanning throttle; measured 2.5-4 s here). The extension therefore only opens the
WebSocket once a server has answered over HTTP.

Overrides:

| Setting | Effect |
|---|---|
| `JOLT_PORT=n` (server env) | Pin the server to exactly port `n`; no fallback. Needed for the original extension (`9009`). |
| `JOLT_BASE_PORT=n` (server env) | Start the 11-port range at `n` instead of 9470 (the extension only scans 9470-9480 on its own). |
| popup → Advanced → *Fixed port* | Make the extension use exactly that port (1024-65535, host always `127.0.0.1`). Also required for a server outside the scanned range. |

### Connection behaviour

- A linked tab survives client restarts: when the server goes away the extension releases the tab, retries with a short
  jittered backoff (about 0.4 s growing to 5 s) and relinks by itself, following the same kind of client if the restart
  lands on another port. It waits at most 15 minutes (then releases the tab and says so), and automatic retries never
  take over a server that another browser is using; only pressing Connect does. A `chrome.alarms` timer (every 30 s) revives the
  service worker if Chrome evicted it, and the link is remembered in `chrome.storage.session` (cleared when the browser
  closes, so nothing re-arms silently after a restart).
- Clicking *Disconnect* (or closing the tab, or dismissing Chrome's debugging banner) is final: the server is told it was
  on purpose and does not wait for a reconnect.
- A tool call made while the extension is mid-reconnect waits up to 4 s (`JOLT_CONNECT_GRACE_MS`, `0` to disable).

## Diagnostics

```bash
JOLT_TRACE=1 node apps/server/dist/index.js            # JSON lines on stderr
JOLT_TRACE=1 JOLT_TRACE_FILE=trace.jsonl …       # or to a file
```

Events: `mcp.received`, `mcp.completed` (tool, duration, response bytes, isError), `ws.send` / `ws.response`
(type, request id, bytes, duration), `ws.timeout`, `ws.hello`, `ws.drop_*`. Each tool call gets a `traceId` so its
WebSocket events correlate. **Only sizes, types and timings are logged**: no payloads, URLs, page text, form values
or cookies. Disabled by default; the disabled path is a single boolean check.

Other environment variables: `JOLT_PORT`, `JOLT_BASE_PORT`, `JOLT_CONNECT_GRACE_MS`,
`JOLT_MAX_SNAPSHOT_CHARS` (0 = unlimited), `JOLT_SEQUENTIAL_SNAPSHOT=1`, `JOLT_KILL_PORT_HOLDER=1`
(only meaningful with `JOLT_PORT`). Every `JOLT_*` variable also accepts its former `BROWSERMCP_*` name (for example
`BROWSERMCP_PORT`) so setups written before the rename keep working; `JOLT_*` wins when both are set.

## The AI cursor

On every `browser_click` / `browser_hover` the extension draws a small brand-coloured pointer at the target (with a
ripple on click) and fades it out after 3 s. It is cosmetic and fire-and-forget: it never delays or fails the real
action. It is built from CSSOM and the Web Animations API inside a closed shadow root (no `innerHTML`, no `<style>`), so
strict CSP / Trusted Types pages cannot block it, and it adds nothing to the page's text or accessibility snapshot (its
animation is inside the shadow root). The `<jolt-cursor>` element itself sits under `<html>`, so a page that looks for
it can tell it is being automated. Toggle it in the popup (stored as `showCursor` in `chrome.storage.local`); turning it off
removes it immediately. It does appear in `browser_screenshot` images.

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
docs             this documentation
```

Licence: Apache-2.0 (upstream `LICENSE` retained). See `NOTICE` for attribution.
