# Browser MCP Turbo

A reliability and performance overhaul of the open-source [Browser MCP](https://github.com/browsermcp/mcp)
server (Apache-2.0), plus an **independent, unofficial reimplementation** of the Chrome extension that server talks to.
The original project is not affiliated with this work.

What changed, in one paragraph: fewer WebSocket round trips per action, optional/bounded page snapshots, a
one-call `browser_batch` tool, event-driven `browser_wait_for`, no hangs when the extension disconnects, a loopback-only
socket, opt-in tracing, and a repeatable benchmark/test harness. Existing tools keep their names and schemas.

- Start here: [docs/local-development.md](docs/local-development.md) (build, load the extension, configure clients)
- What was slow and what was broken: [docs/performance-audit.md](docs/performance-audit.md)
- How it works now: [docs/performance-architecture.md](docs/performance-architecture.md)
- Measured results and their limits: [docs/performance-benchmarks.md](docs/performance-benchmarks.md)
- Tool/protocol compatibility: [docs/compatibility.md](docs/compatibility.md)
- Progress checkpoint: [docs/STATUS.md](docs/STATUS.md)

Attribution: see [NOTICE](NOTICE). Licence: [Apache-2.0](LICENSE).
