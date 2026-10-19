# Security and privacy

Scope: the Jolt server (`apps/server`) and the extension (`apps/extension`). An independent
security review and a code review were run on the code; their findings and what was done are below.

## Model

```
MCP client ─stdio─> server ─ws://127.0.0.1:<port>─> extension ─chrome.debugger─> ONE user-chosen tab
                    └──── http://127.0.0.1:<port>/info (discovery, ports 9470-9480) ────┘
```

The server trusts its MCP client. The extension trusts whoever is on the other end of the loopback socket, and also
whatever answers `GET /info` on the scanned ports (see limitations 1 and 7). Nothing listens on a non-loopback
interface and there is no remote-debugging port. The only plain-HTTP endpoint is `GET /info` (below).

## What is enforced

| Control | Where | Tested by |
|---|---|---|
| WebSocket binds `127.0.0.1` only | `ws.ts` | e2e `listens on loopback only` |
| Web-page origins rejected (403); extension origins and non-browser clients allowed | `ws.ts isAllowedOrigin` | e2e `rejects web-page origins…` |
| WebSocket upgrades and `/info` also require a loopback `Host` header (DNS rebinding) | `ws.ts isLoopbackHost` | `ws.test.ts` |
| `GET /info` (server name, version, pid, port, MCP client name, whether a tab is linked): GET only, extension or no `Origin`, loopback `Host`, **no CORS headers** so web pages cannot read it, `nosniff` | `ws.ts createInfoHandler` | `ws.test.ts` |
| Server answers from `/info` and `welcome` are untrusted: every field type-checked and clamped, reported port must equal the port probed, redirects refused, start time clamped | `probe.ts parseServerInfo` | `parse.test.ts` |
| Automatic reconnects never take over a server another browser is using; only an explicit Connect does | `background.ts findServer` | `real-ux.mjs` |
| An armed tab waits at most 15 minutes for its server (counted from arming or the last drop), then is released | `background.ts retryNow`, `policy.ts ARMED_MAX_MS` | reviewed; not unit-testable without a Chrome API fake |
| The debugger is attached only while linked: it is released as soon as the server goes away (no stuck banner), and on any failed attach | `background.ts releaseTab` | `real-ux.mjs` |
| The AI cursor is injected as a fixed script with only numeric/enum arguments, built from CSSOM + Web Animations (no `innerHTML`/`<style>`), and the popup shows a local monogram instead of loading the page's favicon | `cursor.ts`, `popup.ts` | `cursor.test.ts` |
| Inbound frames schema-validated, oversized frames dropped, `maxPayload` set | `transport/link.ts`, `ws.ts` | link tests |
| Pending requests bounded (64) with per-request timeouts; all rejected on close/replace | `transport/link.ts` | link tests |
| A replaced/closed socket is terminated and cannot crash the server with a late `error` | `transport/link.ts`, `server.ts` | e2e `survives a replaced socket sending garbage`, `closes the replaced socket` |
| No arbitrary-JavaScript tool or batch action; in-page functions are fixed bodies, user values are passed as arguments or JSON-escaped literals | `actions.ts`, `handlers.ts` | batch tests |
| `browser_batch` runs the same `perform()` primitive as the standalone tools; all actions validated before any runs; ≤ 20 actions; time budget | `tools/batch.ts` | batch tests |
| Navigation only to `http(s)://` and `about:blank` (blocks `javascript:`, `data:`, `file:`, `chrome:`) | `handlers.ts` | handler tests |
| Password input values are never emitted in snapshots (checked against the DOM `type`; fails closed if it cannot be determined; at most 50 checks per snapshot, the rest are dropped) | `handlers.ts redactPasswordValues` | handler tests |
| Console buffer cleared on every connect/disconnect (no cross-tab/session leakage) | `background.ts` | reviewed; not unit-testable without a Chrome API fake |
| Extension message handlers looked up with `Object.hasOwn` | `background.ts` | reviewed |
| Extension permissions: `debugger`, `tabs`, `storage`, `alarms` and host access to `http://127.0.0.1/*` only (needed for discovery; Chrome's match pattern covers every loopback port, so the extension *can* read any local HTTP service, but its code only fetches `/info` and `/` on ports 9470-9480 or the port you typed). No content scripts, `externally_connectable` or web-accessible resources | `manifest.json` | — |
| Port-holder kill is opt-in, targets only *listeners*, uses no shell | `utils/port.ts` | reviewed |
| Tracing logs sizes, types and timings only — never page text, URLs, form values or cookies | `utils/trace.ts` | reviewed; opt-in |
| No secrets in the repository | — | grep; none found |

## Known limitations (not fixed)

1. **No pairing authentication between server and extension (review finding, HIGH on shared hosts).**
   Any local process that can bind or connect to `127.0.0.1:<port>` can impersonate the server to the extension
   (and read/drive the connected tab) or impersonate the extension to the server. Web pages cannot (their `Origin`
   is rejected), but another local OS user, a malicious local program, or another installed Chrome extension can.
   This is the same trust model as upstream, and 0.2 widens one edge of it: an armed tab reconnects by itself, so a
   process that binds the old port after the real server exits can inherit the tab (it cannot tell the difference: a
   restarted client legitimately returns on the same port). Mitigations in this repo: loopback only, one tab, visible
   Chrome debugger banner (shown only while linked), explicit user Connect, reconnect window bounded to 15 minutes,
   no takeover of a server another browser holds, validated server answers. **Recommended next step:** a pairing secret
   (generated by the server, entered once in the popup, mutual HMAC challenge in the `hello` exchange), plus
   pinning the extension id in `isAllowedOrigin` and rejecting a missing `Origin` by default.
2. **A timed-out action may still execute.** If the server gives up (timeout, batch budget) the extension may
   still complete the CDP action later, so an agent that retries a "failed" click or submit could perform it twice.
   The server's per-tab write queue advances on timeout, so a late action may overlap the next one.
3. **Screenshots and console logs are not redacted.** Page content reaching the agent is the purpose of the tool,
   but anything visible on the page (including password managers' filled fields rendered as text) can appear in a
   screenshot. Typed text is echoed back in the status line (`Typed "…" into "…"`), which is already in the model's
   context.
4. **The debugger permission is powerful by nature.** While connected, the server can read and act on everything
   in the tab, including authenticated content. Only connect tabs you are willing to expose, and disconnect when done.
5. **Original Web Store extension** was not security-reviewed or tested here.
6. Chrome's own behaviour for `chrome.debugger` on `file:` and Web Store pages (attach is refused) was relied on
   and not otherwise tested.
7. **`/info` and the MCP client name are unauthenticated.** Any local process can answer on a scanned port and claim to
   be "Claude Code"; the popup shows what it is told. A web page can learn only whether *something* listens on a
   loopback port (a blind cross-origin request succeeds but its body is unreadable); it cannot read `/info`. A hostile
   process can also occupy all of 9470-9480 so that no server starts; the server then fails with a clear message.
8. **The AI cursor is detectable.** The `<jolt-cursor>` element is a light-DOM child of `<html>` (its contents are in a
   closed shadow root and it adds nothing to page text or the accessibility snapshot), so a page that looks for it can
   tell it is being automated.
9. **`pnpm run setup --force`** removes then re-adds the Claude Code entry; if the add fails the old entry is gone.
   It keeps timestamped `.bak` copies of VS Code's `mcp.json`, which may contain tokens from other servers; delete old
   backups.

## Responsible use

The tool must not be used to bypass authentication, CAPTCHAs, rate limits or other anti-abuse protections, and
consequential actions (purchases, posting, deleting) should keep a human in the loop at the MCP client. Nothing in
this repo changes the client's permission prompts: `browser_batch` actions are executed exactly like the
equivalent individual tool calls, but a client that asks permission per tool call will see one call for the batch.
