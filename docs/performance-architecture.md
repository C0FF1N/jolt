# Architecture after the overhaul

```
MCP client ──stdio──> server (apps/server) ──ws://127.0.0.1:<port>──> extension (apps/extension)
                        │                                              │
                        ├─ tools/*  (define.ts → actions.ts perform)   ├─ handlers.ts (CDP commands)
                        ├─ Context  (write queue, link lifecycle)      ├─ aria.ts     (AX tree → YAML)
                        └─ transport/link.ts (ExtensionLink)           └─ background.ts (MV3 worker, WS client)
```

## Request lifecycle

1. `tools/call` arrives. `server.ts` opens a trace scope (no-op unless `JOLT_TRACE=1`) and finds the tool.
2. The tool validates its arguments with zod (`tools/define.ts`, `tools/actions.ts`). A `batch` validates **every**
   action before running any.
3. `Context.sendSocketMessage` sends through `ExtensionLink`. State-changing messages are chained on a single
   queue (one tab ⇒ one interaction at a time); read-only messages (`getUrl`, `getTitle`, `browser_snapshot`,
   `browser_snapshot_bundle`, screenshot, console logs) are not queued.
4. `ExtensionLink` correlates by request id using **one** persistent `message` listener and a bounded map;
   every pending request is rejected on close/error/replacement, and each has its own timeout.
5. After an action, if `snapshot` is not `"none"`, `captureAriaSnapshot` reads page state:
   - extension advertised `snapshotBundle` → **1** round trip (`browser_snapshot_bundle` → `{url, title, snapshot}`);
   - otherwise the three independent reads are issued concurrently (set `JOLT_SEQUENTIAL_SNAPSHOT=1` for the
     upstream sequential behaviour);
   then the YAML is bounded by `maxChars` (default 200 000, `JOLT_MAX_SNAPSHOT_CHARS`, `0` = unlimited) and
   a truncation note with an `offset` for continuation is appended.

## Wire protocol additions (backwards compatible)

| Frame | Direction | Purpose |
|---|---|---|
| `{type:"hello", payload:{protocolVersion, capabilities[]}}` | extension → server, once after connect | Advertises `snapshotBundle`, `waitFor`. Legacy extensions never send it; the server then uses only the original message types. |
| `browser_snapshot_bundle` | server → extension | Only sent if `snapshotBundle` was advertised. |
| `browser_wait_for` | server → extension | Only sent if `waitFor` was advertised; otherwise the tool returns an `UNSUPPORTED` error with guidance. |

Inbound frames are validated (zod) and oversized frames (> 64 MiB) are dropped; the WS server also sets `maxPayload`.

## Waiting model

| Need | Mechanism |
|---|---|
| Wait for text to appear/disappear | `browser_wait_for` → in-page `MutationObserver` + timer, both torn down on success and on timeout (`handlers.ts`). Timeout error names the operation and the condition. |
| Navigation | A listener for `Page.loadEventFired` **or** `Page.navigatedWithinDocument` (hash changes, `pushState`, SPA back/forward, which never fire `load`) is registered **before** the navigation starts; capped at 15 s, then the call returns (the page may still be loading) instead of hanging. |
| SPA transitions | Use `browser_wait_for` on the expected text; the `load` event does not imply an SPA is ready, and `networkidle` is deliberately not used. |
| Explicit sleep | `browser_wait` is unchanged, but its transport timeout is now `time + 10 s`, so waits over 30 s work. |

## Resource management

- One WS listener per socket; pending map bounded (default 64) → `BACKPRESSURE` error beyond that.
- Timers cleared on settle; listeners removed when a link is closed or replaced.
- Extension: console buffer ring (500 entries), waiters map cleared on disconnect. The debugger is attached only while
  a server is linked and is released when the link drops, on tab close, when the user dismisses Chrome's banner, and
  on explicit disconnect. After a drop the extension retries with jittered backoff (about 0.4 s growing to 5 s) for
  up to 15 minutes, never takes over a server another browser is using, and follows the same kind of client if it
  comes back on another port. connect/disconnect/resume/retry are serialised, and element refs are reset on every
  connect.
- Discovery: servers are found with a plain HTTP `GET /info` (ports 9470-9480). Chrome delays new WebSocket connects
  by seconds after failed ones, so the WebSocket is only opened once a server has answered.
- MV3 lifetime: Chrome's documentation says only WebSocket *messages* reset a worker's ~30 s idle timer, so while
  connected the extension sends a tiny `{"type":"ping","t":...}` frame every 15 s. The server answers with a `pong`,
  which also gives the popup its round-trip time and lets the extension notice a dead server. If Chrome evicts the
  worker anyway, a 30 s `chrome.alarms` timer revives it and the armed tab is picked up again from
  `chrome.storage.session`. Idle survival and server restarts are covered by `bench/src/real-resilience.mjs`;
  branded, headed Chrome was not tested.
- Server bound: one connected extension; a new connection replaces the old and rejects its pending work with
  `REPLACED`.

## Errors

`BrowserMcpError{code, message, operation?, hint?}` → text `CODE [operation]: message` + `Hint: …`. Codes:
`NO_CONNECTION`, `DISCONNECTED`, `REPLACED`, `TIMEOUT`, `BACKPRESSURE`, `EXTENSION_ERROR`, `INVALID_ARGUMENT`,
`UNSUPPORTED`. Extension errors (e.g. stale ref) are passed through with their message.

## Element targeting

The model-facing contract is unchanged: refs come from the snapshot (`[ref=eN]`). In the new extension a ref maps
to a `backendDOMNodeId`; it is resolved immediately before use, so a ref whose node left the page fails with
"take a new snapshot", and refs are invalidated on navigation. Refs are unique by construction, so there is no
"ambiguous match" case; text/selector targeting (where ambiguity could arise) was deliberately not added.

## Considered and rejected

| Idea | Why not |
|---|---|
| Patch the minified Web Store extension | Unreadable, proprietary, unmaintainable. |
| Compress WebSocket payloads | Loopback; the cost would exceed the saving at observed payload sizes (≤ ~200 KB). Not benchmarked further. |
| Global snapshot cache | Would return stale pages; per-request reuse is already achieved by the 1-round-trip bundle. |
| Unbounded reconnect loops | Retries are jittered, bounded to 15 minutes, never steal a busy server, and discovery uses HTTP so failed attempts are cheap and not throttled. |
| `networkidle` as readiness | Unreliable for SPAs and long-poll pages. |
| Arbitrary JS action (`evaluate`) in batch | Safety: untrusted model input must not run as code. |
| Batch executed inside the extension | Server-side sequencing already yields 1 call for the model and 1 round trip per action; the extra protocol surface was not justified by measurements. |
| Removing `getUrl`/`getTitle` for old extensions | Needed for the unchanged output format; they are now concurrent instead. |
