# Compatibility

`bench/src/compat.test.ts` enforces the tool contract below by starting the unmodified baseline and the
Jolt server and comparing their `tools/list` output.

## Preserved (unchanged name, description, required arguments, original properties)

`browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_wait`, `browser_press_key`,
`browser_snapshot`, `browser_click`, `browser_hover`, `browser_type`, `browser_select_option`,
`browser_screenshot`, `browser_get_console_logs`.

`browser_drag` has a schema and handler upstream but is **not registered** upstream either; it still is not.

## Added (all optional / additive)

| Where | Addition | Default behaviour |
|---|---|---|
| `browser_navigate`, `_go_back`, `_go_forward`, `_click`, `_hover`, `_type`, `_select_option` | optional `snapshot: "full" \| "none"` | `full` = identical to upstream (status text and/or snapshot). `none` returns only the status line. |
| `browser_snapshot` | optional `maxChars` (int ≥ 0), `offset` (int ≥ 0) | `maxChars` defaults to `JOLT_MAX_SNAPSHOT_CHARS` or 200 000; larger pages are truncated **with an explicit note and an `offset` to continue** (upstream returned everything). `0` = unlimited. |
| new tool `browser_wait_for` | `text`, `textGone`, `timeoutMs` | Event-driven wait; needs an extension that advertises `waitFor`, otherwise returns an `UNSUPPORTED` error. |
| new tool `browser_batch` | `actions[1..20]`, `onError`, `timeoutMs`, `finalSnapshot` | Sequential, validated up front; returns JSON with one `{index, action, status: ok\|failed\|skipped, …}` per action. |

Output text of the existing tools is byte-for-byte what upstream produced when `snapshot` is omitted and the
page is under the snapshot limit (the benchmarks show identical response sizes for `click`, `type`,
`navigate`).

## Behaviour changes (intentional)

| Change | Why | Opt-out |
|---|---|---|
| WebSocket binds `127.0.0.1` instead of all interfaces; web-page origins are rejected (extension origins and non-browser clients are accepted). | Security. | none (a LAN-reachable browser-control socket is not a feature) |
| A process already holding the port is **not** killed; the server waits up to 10 s, then fails with an explanatory error. | Upstream force-killed the port owner. | `JOLT_KILL_PORT_HOLDER=1` restores the kill |
| `getUrl`/`getTitle`/`browser_snapshot` after an action are sent concurrently to an extension that does not advertise `snapshotBundle`. | Fewer sequential round trips. **Not verified against the original Web Store extension** (needs a manual connect). | `JOLT_SEQUENTIAL_SNAPSHOT=1` |
| Pending requests are rejected immediately when the extension disconnects or is replaced (upstream: hung until process exit). | Reliability. | none |
| `browser_wait` accepts waits longer than 30 s (up to 300 s). | Upstream failed after 30 s. | none |
| Errors are `CODE [operation]: message` + `Hint:`. | Actionable errors. | none |
| Default port range is **9470-9480** (first free port wins) instead of the fixed 9009; `JOLT_PORT=9009` restores upstream's port. | Several MCP clients can each run a server; the new extension scans the range; the extension never probes 9009, so it cannot disturb a running original server. **The original Web Store extension only connects to 9009**, so set `JOLT_PORT=9009` to use it. | `JOLT_PORT` |
| The server also answers plain HTTP `GET /info` (loopback Host and extension/no Origin only) and waits up to 4 s for a dropped extension before failing a tool call. | Discovery without Chrome's WebSocket throttle; no spurious failures during a reconnect. | `JOLT_CONNECT_GRACE_MS=0` |
| `JOLT_PORT` / `JOLT_BASE_PORT` pin or move the port range. | Side-by-side use, tests. | — |

## Wire protocol

Upstream messages and responses are unchanged. New, all opt-in by capability: `hello` (extension → server),
`browser_snapshot_bundle`, `browser_wait_for`. A legacy extension that never sends `hello` receives only the
original message types.

Extension ↔ server notifications added in 0.2 (no `id`, no response; unknown frames are ignored by both sides):

| Frame | From → to | Purpose |
|---|---|---|
| `welcome` `{name, version, protocolVersion, pid, port, startedAt, client, connected}` | server → extension, only after the extension's `hello` | popup shows "Connected to Claude Code · :9470"; refreshed when the MCP handshake completes |
| `ping` `{t}` / `pong` `{t}` | extension → server → extension | keepalive, round-trip time, dead-server detection (enforced only for servers that sent `welcome`) |
| `bye` | extension → server before a deliberate close | server does not wait for a reconnect |

Discovery is a separate plain-HTTP `GET /info` on the same port returning the `welcome` payload.

## The new extension versus the Web Store extension

`apps/extension` is an independent implementation; it is **not** a drop-in clone.

| Aspect | Web Store v1.3.4 | `apps/extension` |
|---|---|---|
| Name / id | "Browser MCP - Automate your browser…", `bjfgambnhccakkhmkepdoekmckoijdlc` | "Jolt", id assigned by Chrome when loaded unpacked |
| Permissions | `debugger, scripting, storage, tabs, webNavigation` + `<all_urls>` host access + content script | `debugger, tabs, storage, alarms` + host access to `http://127.0.0.1/*` only (server discovery); no content scripts, no `externally_connectable` |
| Snapshot | its own accessibility YAML | `role "name" [flags] [ref=eN]` rows built from `Accessibility.getFullAXTree`; similar shape, **not guaranteed identical** text |
| Keys for `browser_press_key` | unknown (closed source) | single characters; Enter, Tab, Escape, Backspace, Delete, Insert, Space, Arrow keys, Home/End, PageUp/PageDown, F1–F12 (names are case-insensitive); modifier chords such as `Control+a`, `Shift+Tab`, `Control+Shift+a` (Control/Ctrl, Alt, Shift, Meta/Cmd/Command). Anything else errors with the supported list. Compatibility with the original's exact key vocabulary was **not** verified. |
| URL scheme for navigate | unknown | `http(s)://` and `about:blank` only (blocks `javascript:`, `data:`, `file:`, `chrome:`) — stricter than upstream may be; see security.md |
| `browser_type` with empty text | unknown | clears the field |
| Same-document navigation (`go_back` in an SPA, hash changes) | unknown | returns on `Page.navigatedWithinDocument` instead of waiting for a `load` event |
| `browser_drag` | handled (unregistered on the server) | not implemented |
| Connect UX | click icon → Connect | click icon → "Connect this tab" (one tab, shown by the debugger banner); lists the MCP clients it found, remembers your last choice, can wait for a client that has not started yet |
| Port | 9009 | none to type: scans 9470-9480; optional "Fixed port" under Advanced (1024–65535) |
| Reconnect | — | automatic while armed, for up to 15 minutes: releases the tab when the server drops, relinks with jittered backoff (never taking over a server another browser is using), revived by a 30 s alarm if Chrome evicts the worker |
| Visible cursor | — | AI cursor with click ripple (popup toggle) |

## Migration notes

- Using only the original extension with the Jolt server works (legacy path) but you do not get
  `snapshotBundle`, `browser_wait_for` or the one-round-trip snapshot.
- Running the original server and the Jolt server at once: no setup needed. The Jolt server uses 9470-9480, the
  original keeps 9009. (To use the *original extension* with the Jolt server, start the Jolt server with
  `JOLT_PORT=9009` and stop the original server.)
- Do not install both extensions into the same profile and connect both to the same server: only the last
  connection is kept.

## Known limitations

- Original Web Store extension: concurrent reads and `snapshot: "none"` flows are server-side only and were not
  exercised against it here.
- Password fields: the new extension drops the `[value="…"]` of any text box whose DOM `type` is `password` (and
  fails closed if the type cannot be determined). Covered by unit tests with a fake CDP; not exercised against a real
  password field.
- `browser_wait_for` matches on `document.body.innerText`; it does not see text inside closed shadow roots or
  cross-origin iframes.
