# Jolt privacy policy

_Last updated: 2026-10-19_

Jolt (the Chrome extension) and `jolt-mcp` (its companion server) are open-source software by C0FF1N.

**Jolt does not collect, store, sell, share or transmit your data to its developer or to any third party. There are no
accounts, no analytics, no telemetry, and the extension downloads and runs no remote code.**

## What Jolt can access, and when

Only after you press **Connect this tab**, only for that one tab, and only until you disconnect, close the tab or close
the browser:

- the page content as an accessibility snapshot (text, roles, labels; the values of password fields are never included);
- the tab's URL and title;
- screenshots and console messages, when your MCP client asks for them;
- the ability to click, type, press keys, choose options, scroll and navigate (http/https only) in that tab, as
  directed by your MCP client.

Jolt does nothing on tabs you have not connected, and nothing while disconnected. While a tab is connected, Chrome shows
its "started debugging this browser" notice.

Screenshots and console output are not filtered: if something sensitive is visible on the page, it can appear in them.

## Where that data goes

Only to the Jolt server running **on your own computer**, over the loopback address (`127.0.0.1`), never over the
internet. The server hands it to the MCP client (for example Claude Code or VS Code) that started it.

That client is software you chose and configured. **What it does with the data, including sending it to an AI model
provider, is governed by that client's own terms and privacy policy, not by Jolt.** Connect only tabs you are
comfortable sharing with that client.

## What Jolt stores

On your device only:

- settings in `chrome.storage.local`: whether the AI cursor is shown, the last server port used, and an optional fixed
  port you typed;
- the connected tab's id, the local server's port and MCP client name, and the time the link last changed, in
  `chrome.storage.session`, which Chrome erases when the browser closes.

Nothing is synced or uploaded. The server keeps nothing on disk unless you switch on its optional trace log
(`JOLT_TRACE_FILE`), which records only timings and sizes, never page content.

## Why each permission is needed

| Permission | Why |
|---|---|
| `debugger` | Operates the connected tab: reads its accessibility tree, takes screenshots, and sends clicks, typing and navigation through the Chrome DevTools Protocol. Attached only to the tab you connect; released on disconnect or when the local server goes away. |
| `tabs` | Reads the connected tab's URL and title (shown in the popup, used to refuse pages Chrome does not allow) and finds the active tab so the popup can connect it. |
| `storage` | Remembers the settings and session described above. |
| `alarms` | Wakes the extension every 30 seconds while a tab is armed, so it can reconnect to the local server after Chrome suspends it. |
| `http://127.0.0.1/*` | Finds your local Jolt server by asking `http://127.0.0.1:<port>/info` on ports 9470-9480. Loopback only; no external hosts. |

## How the data is used

Only to provide the extension's single purpose: letting an MCP client you run locally operate the one tab you
explicitly connect. It is not used for advertising, profiling or credit decisions, it is not sold or transferred except
to your own local MCP client as described above, and no person at Jolt can see it.

## Children

Jolt is a developer tool and is not directed at children.

## Verify it yourself

Everything described here is open source (Apache-2.0) at <https://github.com/C0FF1N/jolt>. The security model and its
known limitations are in [docs/security.md](docs/security.md).

## Changes

Changes to this policy are made in the repository and noted in the [changelog](CHANGELOG.md); the date above is updated.

## Contact

Open an issue at <https://github.com/C0FF1N/jolt/issues>. For security problems, see [SECURITY.md](SECURITY.md).
