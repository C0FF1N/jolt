# Browser MCP Turbo

A reliability and performance overhaul of the open-source [Browser MCP](https://github.com/browsermcp/mcp)
server (Apache-2.0), plus an **independent, unofficial reimplementation** of the Chrome extension that server talks to.
The original project is not affiliated with this work.

What changed, in one paragraph: fewer WebSocket round trips per action, optional/bounded page snapshots, a
one-call `browser_batch` tool, event-driven `browser_wait_for`, no hangs when the extension disconnects, a loopback-only
socket, opt-in tracing, and a repeatable benchmark/test harness. Existing tools keep their names and schemas.

## Quick start

You need Node 22+ and Chrome. Pick **A** (from a release, no build) or **B** (from source).

### A. From a release (only Node needed)

1. Download `browsermcp-turbo-extension.zip` and `browsermcp-turbo-server.mjs` from the
   [latest release](../../releases/latest) and unzip the extension into a folder.
2. Chrome → `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose that folder.
3. Register the server (use the absolute path to the `.mjs`):
   ```bash
   claude mcp add browsermcp-turbo -- node /absolute/path/to/browsermcp-turbo-server.mjs
   ```
   Other clients: see [docs/local-development.md](docs/local-development.md).

### B. From source

```bash
git clone https://github.com/<you>/browsermcp-turbo.git
cd browsermcp-turbo
corepack enable
pnpm install
pnpm run quickstart     # builds everything and prints the exact extension path + MCP config for this checkout
```

Then follow the three printed steps (load `apps/extension/dist` in Chrome, register the server, connect a tab).
Re-print them any time with `pnpm run config` (add `-- --port=9010` if the original Browser MCP already uses 9009).

### Use it

Open the page you want automated → click the **Browser MCP Turbo** icon → **Connect this tab**. Chrome shows a
"started debugging this browser" banner; that is expected. Then ask your AI client to use the `browsermcp-turbo` tools.
Only connect tabs you are willing to expose; read [docs/security.md](docs/security.md).

## Docs

- Build, load the extension, configure clients: [docs/local-development.md](docs/local-development.md)
- What was slow and what was broken: [docs/performance-audit.md](docs/performance-audit.md)
- How it works now: [docs/performance-architecture.md](docs/performance-architecture.md)
- Measured results and their limits: [docs/performance-benchmarks.md](docs/performance-benchmarks.md)
- Tool/protocol compatibility: [docs/compatibility.md](docs/compatibility.md)
- Security model and known limitations: [docs/security.md](docs/security.md)
- Progress checkpoint: [docs/STATUS.md](docs/STATUS.md)

Attribution: see [NOTICE](NOTICE). Licence: [Apache-2.0](LICENSE).
