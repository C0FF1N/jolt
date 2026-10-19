# Changelog

All notable changes to Jolt are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com) and the
project uses [Semantic Versioning](https://semver.org).

## [1.0.0] - 2026-10-19

First public release, under the name **Jolt** (previously developed as "Browser MCP Turbo").

### Added

- A branded Chrome extension: live status popup (detected MCP clients by name, round-trip time, switch/disconnect), toolbar
  badge, icons, and a disclosure notice shown before anything is shared.
- The AI cursor: a pointer that glides to every click and hover, with a ripple on click (toggle in the popup).
- Automatic discovery of several MCP servers at once (ports 9470-9480) over plain HTTP `GET /info`, so Claude Code and
  VS Code can run together with no port to type.
- Self-healing connection: the tab is released while the server is away (no stuck debugging banner), the extension
  reconnects with jittered backoff (waits up to 15 minutes, follows the same client across a port change, never takes
  over a server another browser is using), and a 30-second alarm revives an evicted service worker.
- `welcome`, `pong` and `bye` frames; a 4-second grace wait for tool calls made during a reconnect.
- `pnpm run setup`: registers the server with Claude Code and VS Code (never overwrites without `--force`).
- Release tooling: Chrome Web Store packaging with rule checks and a reproducible zip, store listing copy and generated
  images, version-sync check, tag-driven release workflow with npm provenance.
- `PRIVACY.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`.

### Changed

- Renamed from "Browser MCP Turbo": the npm package is `jolt-mcp`, the environment variables are `JOLT_*` (the old
  `BROWSERMCP_*` names still work).
- The default server port range is 9470-9480 instead of the fixed 9009, so Jolt can run next to the original Browser MCP.
  To use the *original* extension with this server, set `JOLT_PORT=9009`.
- The npm package ships one self-contained file and has no runtime dependencies.

### Security

- Server answers are validated and clamped before use; `/info` requires a loopback `Host` and sends no CORS headers; the
  WebSocket upgrade also checks `Host`. See `docs/security.md`.

## [0.2.0] - 2026-10-19 (internal)

UX and connection overhaul of the extension and server: popup, cursor, discovery, reconnect, setup script.

## [0.1.0] - 2026-10-13 (internal)

Performance and reliability overhaul of the Browser MCP server (fewer round trips, bounded snapshots, `browser_batch`,
`browser_wait_for`, loopback-only socket, no hangs on disconnect), an independent MV3 extension, and a benchmark harness.
