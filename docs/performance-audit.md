# Performance audit (baseline = upstream `browsermcp/mcp` v0.1.3)

Everything here was verified by reading the upstream source, running it, or measuring it. Items that
are still hypotheses say so. Numbers live in [performance-benchmarks.md](performance-benchmarks.md)
(generated from raw JSON); this document only states structural facts and cites where they were measured.

## 1. What was actually in the repository

| Fact | Evidence |
|---|---|
| `mcp-main/` is byte-identical to `github.com/browsermcp/mcp` (6 commits, Apache-2.0, last push 2025-04-24). | `gh api repos/browsermcp/mcp/git/trees/main` lists the same 22 files. |
| It is **only the MCP server** (~640 lines of TypeScript). There is no extension source, no tests, no lint config, no lockfile, no docs. | File listing. |
| It cannot build alone: it imports `@repo/config`, `@repo/types`, `@repo/messaging`, `@repo/utils`, `@r2r/messaging` (all `workspace:*` in an unpublished monorepo). | `package.json`; the README says so. |
| Those packages are recoverable: the published `@browsermcp/mcp@0.1.3` bundle inlines every runtime module with source-path comments. | `dist/index.js` markers `../../packages/config/src/app.config.ts` etc. |
| The Chrome extension exists only as a minified, un-sourcemapped Web Store build (v1.3.4, MV3; permissions `debugger, scripting, storage, tabs, webNavigation`; `<all_urls>`). Its source is not recoverable. | Installed extension directory. |

Consequences: `packages/*` here are reconstructions from the published bundle (the rebuilt `baseline/`
differs from the published bundle only in comments and formatting), and the extension in `apps/extension`
is an **independent reimplementation** of the wire protocol, not an optimisation of the original.

## 2. Architecture

```
MCP client ──stdio──> MCP server (Node) ──WebSocket 127.0.0.1:9009──> Extension service worker
                       src/index.ts, server.ts                          chrome.debugger (CDP) ──> one tab
```

- Tools are plain objects `{schema, handle}`; schemas come from zod definitions in `@repo/types/mcp/tool`.
- `Context` holds the single extension WebSocket. A new connection replaces (and closes) the old one.
- Protocol (reconstructed from the bundle): server sends `{id, type, payload}`; extension answers
  `{type: "messageResponse", payload: {requestId, result | error}}`. 30 s default timeout.
- Messages used: `getUrl`, `getTitle`, `browser_snapshot`, `browser_navigate`, `browser_go_back`,
  `browser_go_forward`, `browser_wait`, `browser_press_key`, `browser_click`, `browser_hover`,
  `browser_type`, `browser_select_option`, `browser_screenshot`, `browser_get_console_logs`
  (`browser_drag` has a schema and handler but is not registered in `index.ts`).

## 3. Request/response lifecycle (baseline)

`tools/call` → `server.ts` finds tool → `tool.handle` → `context.sendSocketMessage` →
`createSocketMessageSender` (new listener per request) → extension → response → (for action tools)
**`captureAriaSnapshot`: three more sequential round trips** (`getUrl`, `getTitle`, `browser_snapshot`).

## 4. Findings

Severity: **Bug** (wrong behaviour), **Perf** (cost), **Risk** (exposure).

| # | Finding | Kind | Verified by |
|---|---|---|---|
| 1 | Every action tool (click, hover, type, select, navigate, back, forward) is followed by a full snapshot made of 3 *sequential* round trips: **4 round trips per action, 36 per 10-action sequence**. | Perf | Round trips counted by the mock extension (`bench/results/baseline-*`). |
| 2 | The full YAML snapshot is returned after every action whether or not the caller wants it. Page-sized payload on every call. | Perf | Response bytes in the benchmarks; per-action response ≈ snapshot size. |
| 3 | `createSocketMessageSender` adds a new `message` listener per request; each listener `JSON.parse`s every incoming frame. Cost grows with pending requests × frames. | Perf (hypothesis for real-world impact; low at observed concurrency 1) | Source (dist l.26-100). |
| 4 | On socket `close` the sender calls `cleanup` **without rejecting**: the timeout is cleared and the promise never settles. A disconnect mid-call hangs the tool call forever. | Bug | Source; regression test `link.test.ts › rejects every pending request when the socket closes`. |
| 5 | `server.close` is reassigned to a function that calls `server.close()` → **infinite recursion** (stack overflow). | Bug | **Reproduced**: closing the unmodified baseline server produced `RangeError: Maximum call stack size exceeded` at `server.close`. |
| 6 | The WebSocket server binds all interfaces (no `host`) and accepts any origin. | Risk | Source; turbo tests `listens on loopback only`, `rejects web-page origins`. |
| 7 | `killProcessOnPort` force-kills whatever owns the port on every start (it would terminate another running Browser MCP server, or an unrelated program). The Windows form (`FOR /F … %a`) is batch syntax and is not valid when run through `execSync` directly; it fails and only logs. | Risk/Bug | Source. |
| 8 | `browser_wait` goes through the 30 s transport timeout, so any wait longer than ~30 s fails. | Bug | Source. |
| 9 | Waiting is fixed-time only (`browser_wait`); there is no condition wait, so callers sleep conservatively. | Perf | Source. |
| 10 | No ordering between concurrent tool calls: two actions on the same tab could interleave. | Risk | Source. |
| 11 | No output bound: a very large page returns an arbitrarily large snapshot. | Risk/Perf | Source; `snapshot_large` benchmark (~180 KB for 5 000 buttons). |
| 12 | Errors are raw strings with no recovery guidance. | UX | Source. |

### Existing delays and wait strategies

The server contains **no** artificial `sleep`s. Its only wait primitives are the 30 s response timeout
and `wait(100)` while polling for the port to free (`ws.ts`). Fixed waiting exists only as the explicit
user-requested `browser_wait`, which is preserved. (The original extension's internals are unknown.)

### Not a bottleneck (measured)

With a zero-latency mock extension, the server adds on the order of 0.3 ms per WebSocket round trip, and
standard tool latency against a real local Chromium is dominated by the browser (click ≈ 6 ms, large
snapshot ≈ 0.7 s). The server's CPU is not the problem; **round-trip count, payload size and reliability
are**. This is why the optimisations target those and not micro-optimisation of the server.

## 5. Memory and resource risks (baseline)

- Pending requests leak on disconnect (finding 4): a closure, a timer-less promise and 3 listeners each.
- Per-request listeners (finding 3) are removed on success/timeout, but not on close (finding 4).
- No bound on frame size, pending count or snapshot size.
- `execSync` shelling out with a value derived from config (numeric, but still a shell string).

## 6. Compatibility constraints

- Preserve every upstream tool name, description and input schema; only add optional properties and new tools
  (enforced by `bench/src/compat.test.ts`).
- The original extension may be installed by users; the server must keep working with an extension that
  never sends the new `hello` handshake (legacy path), and must not send message types it does not know unless
  the extension advertised the capability.
- MV3 service workers can be evicted; no assumption of a permanent connection.

## 7. Baseline results and pre-existing failures

- Install: needs the reconstructed workspace packages; with them `pnpm install` succeeds.
- `tsc --noEmit` (baseline): **passes**. Build (`tsup`): **passes**.
- Tests: **none exist upstream**. Lint: **no configuration upstream**.
- Reproduced pre-existing defect: finding 5 (stack overflow on shutdown).
- Baseline measurements: see [performance-benchmarks.md](performance-benchmarks.md).

## 8. Prioritised plan (and what was done)

| Priority | Change | Status |
|---|---|---|
| P0 | Reject pending on close; single listener; bounded pending; timeouts with structured errors | Done (`transport/link.ts`) |
| P0 | Fix `server.close` recursion; bind loopback; origin check; stop force-killing by default | Done |
| P1 | Cut round trips: 1-call snapshot bundle (capability negotiated) or concurrent reads fallback | Done |
| P1 | Optional `snapshot: "none"` on action tools; bounded snapshot with truncation note + `offset` continuation | Done |
| P1 | `browser_wait_for` (event-driven, MutationObserver, cleaned up) | Done |
| P1 | `browser_batch` (≤ 20 actions, sequential, per-action results) | Done |
| P2 | Per-tab write serialisation | Done |
| P2 | Opt-in tracing | Done |
| — | Compression, caches, heartbeats, `networkidle` | Rejected, see [performance-architecture.md](performance-architecture.md) |
