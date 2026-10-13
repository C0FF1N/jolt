# Status checkpoint

Complete. Last full verification run is listed at the bottom; every number in the docs comes from `bench/results/*.json`
via `bench/src/report.mjs`.

## Done
- **P0** Workspace scaffold; `@repo/*` / `@r2r/messaging` reconstructed from the published `@browsermcp/mcp@0.1.3`
  bundle. `baseline/` (pristine upstream src) and `apps/server` build and typecheck. `mcp-main/` untouched (hash check).
- **P1** Opt-in tracing (`BROWSERMCP_TRACE=1`, sizes/timings only).
- **P2** Benchmark harnesses: mock extension (`bench/src/run.mjs`) and real headless Chromium A/B
  (`bench/src/real-bench.mjs`); generated report `docs/performance-benchmarks.md`.
- **P3** `ExtensionLink` (single listener, bounded pending, reject-on-close, timeouts, structured errors), loopback
  bind + origin check, `server.close` recursion fix, per-tab write serialisation, replaced-socket termination.
- **P4** 1-round-trip snapshot bundle (capability negotiated) / concurrent reads fallback, bounded snapshots with
  truncation note + `offset`, optional `snapshot: "none"`, `browser_wait_for`, `browser_wait` > 30 s.
- **P5** `browser_batch`.
- **P6** New MV3 extension `apps/extension` (CDP-based), popup with port field, keepalive ping, serialised
  connect/disconnect/resume.
- **P7/P8** Tests, A/B benchmarks, docs: audit, architecture, benchmarks, local-development, compatibility, security.
- Independent code review + security review run; findings fixed or documented (`docs/security.md`).

## Verification
`pnpm -r typecheck`, `pnpm -r build`, `pnpm test` (80 tests: unit, compatibility vs baseline, protocol e2e over a real
WebSocket), `node bench/src/real-smoke.mjs` (17/17 turbo, 10/10 baseline), `node bench/src/real-resilience.mjs` (10/10).

## Not done / next
- Pairing authentication between extension and server (see security.md limitation 1).
- The original Web Store extension was not exercised (needs a manual Connect click).
- Headed/branded Chrome was not tested (Playwright headless Chromium 153 only); branded Chrome 137+ ignores
  `--load-extension`, so loading is manual.
- A timed-out action can still run in the extension (security.md limitation 2).
