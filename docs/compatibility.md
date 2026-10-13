# Compatibility

`bench/src/compat.test.ts` enforces the tool contract below by starting the unmodified baseline and the
turbo server and comparing their `tools/list` output.

## Preserved (unchanged name, description, required arguments, original properties)

`browser_navigate`, `browser_go_back`, `browser_go_forward`, `browser_wait`, `browser_press_key`,
`browser_snapshot`, `browser_click`, `browser_hover`, `browser_type`, `browser_select_option`,
`browser_screenshot`, `browser_get_console_logs`.

`browser_drag` has a schema and handler upstream but is **not registered** upstream either; it still is not.

## Added (all optional / additive)

| Where | Addition | Default behaviour |
|---|---|---|
| `browser_navigate`, `_go_back`, `_go_forward`, `_click`, `_hover`, `_type`, `_select_option` | optional `snapshot: "full" \| "none"` | `full` = identical to upstream (status text and/or snapshot). `none` returns only the status line. |
| `browser_snapshot` | optional `maxChars` (int ≥ 0), `offset` (int ≥ 0) | `maxChars` defaults to `BROWSERMCP_MAX_SNAPSHOT_CHARS` or 200 000; larger pages are truncated **with an explicit note and an `offset` to continue** (upstream returned everything). `0` = unlimited. |
| new tool `browser_wait_for` | `text`, `textGone`, `timeoutMs` | Event-driven wait; needs an extension that advertises `waitFor`, otherwise returns an `UNSUPPORTED` error. |
| new tool `browser_batch` | `actions[1..20]`, `onError`, `timeoutMs`, `finalSnapshot` | Sequential, validated up front; returns JSON with one `{index, action, status: ok\|failed\|skipped, …}` per action. |

Output text of the existing tools is byte-for-byte what upstream produced when `snapshot` is omitted and the
page is under the snapshot limit (the benchmarks show identical response sizes for `click`, `type`,
`navigate`).

## Behaviour changes (intentional)

| Change | Why | Opt-out |
|---|---|---|
| WebSocket binds `127.0.0.1` instead of all interfaces; web-page origins are rejected (extension origins and non-browser clients are accepted). | Security. | none (a LAN-reachable browser-control socket is not a feature) |
| A process already holding the port is **not** killed; the server waits up to 10 s, then fails with an explanatory error. | Upstream force-killed the port owner. | `BROWSERMCP_KILL_PORT_HOLDER=1` restores the kill |
| `getUrl`/`getTitle`/`browser_snapshot` after an action are sent concurrently to an extension that does not advertise `snapshotBundle`. | Fewer sequential round trips. **Not verified against the original Web Store extension** (needs a manual connect). | `BROWSERMCP_SEQUENTIAL_SNAPSHOT=1` |
| Pending requests are rejected immediately when the extension disconnects or is replaced (upstream: hung until process exit). | Reliability. | none |
| `browser_wait` accepts waits longer than 30 s (up to 300 s). | Upstream failed after 30 s. | none |
| Errors are `CODE [operation]: message` + `Hint:`. | Actionable errors. | none |
| `BROWSERMCP_PORT` changes the port (default stays 9009). | Side-by-side use, tests. | — |

## Wire protocol

Upstream messages and responses are unchanged. New, all opt-in by capability: `hello` (extension → server),
`browser_snapshot_bundle`, `browser_wait_for`. A legacy extension that never sends `hello` receives only the
original message types.

## The new extension versus the Web Store extension

`apps/extension` is an independent implementation; it is **not** a drop-in clone.

| Aspect | Web Store v1.3.4 | `apps/extension` |
|---|---|---|
| Name / id | "Browser MCP - Automate your browser…", `bjfgambnhccakkhmkepdoekmckoijdlc` | "Browser MCP Turbo (unofficial)", id assigned by Chrome when loaded unpacked |
| Permissions | `debugger, scripting, storage, tabs, webNavigation` + `<all_urls>` host access + content script | `debugger, tabs, storage`; no host permissions, no content scripts, no `externally_connectable` |
| Snapshot | its own accessibility YAML | `role "name" [flags] [ref=eN]` rows built from `Accessibility.getFullAXTree`; similar shape, **not guaranteed identical** text |
| Keys for `browser_press_key` | unknown (closed source) | single characters; Enter, Tab, Escape, Backspace, Delete, Insert, Space, Arrow keys, Home/End, PageUp/PageDown, F1–F12 (names are case-insensitive); modifier chords such as `Control+a`, `Shift+Tab`, `Control+Shift+a` (Control/Ctrl, Alt, Shift, Meta/Cmd/Command). Anything else errors with the supported list. Compatibility with the original's exact key vocabulary was **not** verified. |
| URL scheme for navigate | unknown | `http(s)://` and `about:blank` only (blocks `javascript:`, `data:`, `file:`, `chrome:`) — stricter than upstream may be; see security.md |
| `browser_type` with empty text | unknown | clears the field |
| Same-document navigation (`go_back` in an SPA, hash changes) | unknown | returns on `Page.navigatedWithinDocument` instead of waiting for a `load` event |
| `browser_drag` | handled (unregistered on the server) | not implemented |
| Connect UX | click icon → Connect | click icon → "Connect this tab" (one tab, shown by the debugger banner) |
| Port | 9009 | 9009 by default; editable in the popup ("Server port", 1024–65535, remembered) for use with `BROWSERMCP_PORT` |

## Migration notes

- Using only the original extension with the turbo server works (legacy path) but you do not get
  `snapshotBundle`, `browser_wait_for` or the one-round-trip snapshot.
- Running the original server and the turbo server at once: they share port 9009. Set `BROWSERMCP_PORT` for one of
  them (and connect the extension to the same port).
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
