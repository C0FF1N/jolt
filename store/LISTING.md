# Chrome Web Store listing: copy, answers and checklist

Everything to paste into the developer dashboard (<https://chrome.google.com/webstore/devconsole>), in the order the
dashboard asks. Requirements were checked against Google's current documentation in October 2026; where the
documentation was unclear it is marked **verify in the dashboard**.

## Package

Upload `release/jolt-extension-<version>.zip` from `pnpm package:extension` (it enforces the store rules below and is
byte-reproducible; its SHA-256 sits next to it). Assets are in [`assets/`](assets/).

## Store listing tab

| Field | Value |
|---|---|
| Name | taken from the manifest: **Jolt: AI browser control (MCP)** (30/75 characters) |
| Summary | taken from the manifest: *Let Claude Code, VS Code and other MCP clients drive one browser tab you choose. Visible, self-healing, and local-only.* (119/132) |
| Category | Developer Tools |
| Language | English |
| Store icon | `assets/icon-128.png` (96px artwork + 16px transparent padding, as Google specifies) |
| Screenshots | `assets/screenshot-1.jpg` ... `screenshot-5.jpg` (1280x800, JPEG so there is no alpha channel) |
| Small promo tile | `assets/promo-small-440x280.jpg` |
| Marquee promo tile | `assets/promo-marquee-1400x560.jpg` (optional) |
| Homepage URL | <https://github.com/C0FF1N/jolt> |
| Support URL | <https://github.com/C0FF1N/jolt/issues> |

### Detailed description

```text
Jolt lets MCP clients that can launch a local server, such as Claude Code and VS Code (Copilot agent mode), use your real browser: the one tab you choose, already logged in, on your own computer.

HOW IT WORKS
1. Install Jolt (this extension) and add the free, open-source Jolt server to your MCP client. It is one line, shown at github.com/C0FF1N/jolt.
2. Open a page, click the Jolt icon and press "Connect this tab".
3. Ask your AI to work on the page: read it, click, type, fill forms, take screenshots, check the console.

WHY JOLT
• Visible: a cursor glides to every click, so you always see what the AI is doing. Turn it off any time.
• Seamless: Claude Code and VS Code can run at the same time. Jolt finds each of them automatically.
• Self-healing: restart your client and Jolt reconnects by itself, usually within a second.
• Lean: a one-call batch tool, optional snapshot-free actions and bounded page snapshots.
• Private: everything stays on your computer (127.0.0.1). No account, no telemetry, no remote code.
• Open source (Apache-2.0): github.com/C0FF1N/jolt
• You stay in control: nothing happens until you press Connect on a tab. Chrome shows its debugging notice while a tab is connected. Disconnect whenever you like.

REQUIRES A COMPANION PROGRAM
Jolt needs the Jolt MCP server (npm package "jolt-mcp", run with: npx -y jolt-mcp), which your MCP client launches for you. Without it the popup simply says "No MCP client yet".

IMPORTANT
Connecting a tab lets your MCP client, and whatever AI service that client uses, read and control that tab. Only connect tabs you are comfortable sharing.

Jolt is an independent project. It is not affiliated with or endorsed by Anthropic, Microsoft or the Browser MCP project; product names are used only to describe compatibility.
```

## Privacy tab

**Single purpose** (paste as written):

> Let an MCP client that the user runs on their own computer operate one browser tab that the user explicitly connects.

**Permission justifications** (the dashboard asks for each):

| Permission | Justification |
|---|---|
| `debugger` | Required to operate the connected tab: read its accessibility tree, take screenshots, and send clicks, typing and navigation through the Chrome DevTools Protocol. It is attached only to the tab the user explicitly connects and is detached on disconnect or when the local server goes away. |
| `tabs` | Reads the connected tab's URL and title (shown in the popup and used to refuse pages Chrome does not allow) and finds the active tab so the popup can connect it. |
| `storage` | Stores the AI-cursor on/off setting, the last-used local server port, and, in session storage, the connected tab so the link resumes after the service worker restarts. |
| `alarms` | Wakes the service worker every 30 seconds while a tab is armed so it can reconnect to the local server after Chrome suspends the worker. |
| Host permission `http://127.0.0.1/*` | Finds the user's local Jolt server by requesting `http://127.0.0.1:<port>/info` on ports 9470-9480. Loopback only; no external hosts are contacted. |

**Remote code:** *No, I am not using remote code.* (True: `scripts/package-extension.mjs` fails the build on `eval`,
`new Function`, `importScripts` or remote scripts.)

**Data usage** (verify the exact labels in the dashboard; tick every category whose data the extension can read from the
connected tab):

- Website content: yes (page text and screenshots, sent only to the user's local server).
- Web history: yes (URL and title of the connected tab).
- Everything else (personally identifiable information, health, financial, authentication, personal communications,
  location, user activity): not collected or stored by Jolt.

**Certifications** (all three can be ticked): not sold or transferred to third parties outside the approved use cases;
not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.

**Privacy policy URL:** <https://github.com/C0FF1N/jolt/blob/main/PRIVACY.md> (the repository must be public first).

**Prominent disclosure:** Google's 2026 policy requires data handling to be disclosed in the product UI, not only here.
The popup shows a notice above the Connect button ("Connecting lets your AI client read and control this tab...").

## Test instructions tab

> No account or login is needed. Jolt is inert until a local MCP server is running, which is the intended design.
>
> 1. Install the extension.
> 2. Install Node.js 22+, then in a terminal run `npx -y jolt-mcp` and leave it running (it listens only on 127.0.0.1:9470).
> 3. Open any https page, click the Jolt toolbar icon. The popup lists the detected server; press "Connect this tab".
>    The status becomes "Connected" and Chrome shows its "started debugging this browser" bar.
> 4. Press "Disconnect". The bar disappears. Stop the server and the popup returns to "No MCP client yet".
>
> A 60-second walkthrough video: <paste the unlisted video link here>.

Record that video (screen capture of steps 2-4) before submitting; reviewers can only see the extension work if they run
the companion server.

## Before you press "Submit for review"

- [ ] Chrome Web Store developer account created (one-time registration fee; 2-Step Verification on the Google account).
- [ ] Trader or non-trader declared (EU DSA). A **trader's legal name, phone and address are shown publicly**; read
      Google's definition and choose honestly for your situation. **Verify in the dashboard** whether the publisher
      display name may be the handle "C0FF1N"; Google did not document this.
- [ ] `jolt-mcp` is published on npm (the reviewer steps above need it).
- [ ] GitHub repository is public and `PRIVACY.md` loads at the URL above.
- [ ] `pnpm test` is green, `pnpm package:extension` passes, and the zip's version is higher than any version already
      uploaded.
- [ ] Walkthrough video recorded and linked in the test instructions.
- [ ] Searched the Web Store for "Jolt" to confirm the name is not confusingly close to an existing extension.

Expect a closer review than average: `debugger` is a sensitive permission and the extension is new. Google says reviews
take from a few days to a few weeks; contact support after three weeks.

## After approval

- [ ] Add the store link to `README.md` and `apps/server/README.md`.
- [ ] Tag the release (`git tag v1.0.0 && git push origin v1.0.0`) if you have not already; see
      [docs/releasing.md](../docs/releasing.md).
