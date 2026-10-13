# Status checkpoint

Last updated after P5. Source of truth for what is done / next.

## Done (verified by commands run)
- **P0** Workspace scaffold; `@repo/*` / `@r2r/messaging` shims reconstructed from the published
  `@browsermcp/mcp@0.1.3` bundle. `baseline/` (pristine upstream src) and `apps/server` build and
  typecheck. The baseline build differs from the published bundle only in comments/formatting.
  `mcp-main/` is untouched (sha256 comparison).
- **P1** Opt-in tracing (`BROWSERMCP_TRACE=1`, sizes/timings only) in `apps/server/src/utils/trace.ts`.
- **P2** Benchmark harness (`bench/`): mock extension + MCP stdio client; raw JSON in `bench/results/`.
- **P3** `ExtensionLink` (single listener, bounded pending, reject-on-close, timeouts, structured errors),
  loopback bind + origin check, `server.close` recursion fix, per-tab write serialization.
- **P4** Concurrent/bundled snapshot reads, bounded snapshot output with truncation note + `offset`
  continuation, optional `snapshot: "none"` on action tools, `browser_wait_for`, `browser_wait` no longer
  capped at 30 s.
- **P5** `browser_batch` (≤20 actions, stop/continue, budget, per-action results, no JS eval).
- Tests: 28 passing (`pnpm test`): link, bound, batch, tool-contract compatibility vs baseline.

## Not done yet
- **P6** New MV3 extension (`apps/extension`) — speaks the same WS protocol; must advertise
  `hello` capabilities `snapshotBundle`, `waitFor`.
- Real-Chrome E2E + real-Chrome benchmarks (cold/warm).
- Docs: performance-audit, performance-architecture, performance-benchmarks, local-development, compatibility.
- Final A/B report.

## Known caveats
- Mock benchmarks measure server/protocol overhead only (extension latency is simulated, set to 0 in
  the headline runs). On Windows `setTimeout(1)` is quantised to ~15.6 ms, so `--rtt=1` runs
  (`baseline-mock-rtt1-timer-quantized.json`) are dominated by timer granularity.
- Concurrent `getUrl/getTitle/browser_snapshot` against the *Web Store* extension is not verified
  (needs a manual Connect click in Chrome); set `BROWSERMCP_SEQUENTIAL_SNAPSHOT=1` to restore upstream sequential reads.
