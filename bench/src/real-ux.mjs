// Real-browser end-to-end check of the user-facing behaviour, with screenshots:
//   auto-discovery (no port typed), several MCP clients at once, the AI cursor, popup states,
//   and automatic reconnect after the server goes away and comes back (no clicks).
// Usage: node src/real-ux.mjs [--out=<dir for screenshots>] [--ext=<extension dir, default apps/extension/dist>]
// Uses the default unpinned server port range (9470-9480), exactly like a real user setup.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "./chrome.mjs";
import { startFixtureServer } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.join("=") || "true"];
}));
const outDir = args.out ?? path.join(root, "bench/results/ux");
mkdirSync(outDir, { recursive: true });
const entry = path.join(root, "apps/server/dist/index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};

// Servers started by THIS script, by pid. Anything else on the default ports (a developer's live
// Claude Code server, say) is never counted, linked to, or disturbed.
const ours = new Set();

async function startClient(name) {
  const env = { ...process.env };
  delete env.JOLT_PORT; // unpinned: auto port selection
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "pipe" });
  const client = new Client({ name, version: "0" });
  transport.stderr?.on('data', (d) => console.log('      [server ' + name + ']', String(d).trim()));
  await client.connect(transport);
  ours.add(transport.pid);
  await sleep(300);
  return { pid: transport.pid, client, call: (n, a = {}) => client.callTool({ name: n, arguments: a }, undefined, { timeout: 30000 }) };
}

const fixtures = await startFixtureServer();
const chrome = await launchChrome({ extensionDir: args.ext ?? path.join(root, "apps/extension/dist") }); // --ext=<dir> to test an unpacked store zip
console.log(`chromium ${chrome.version}`);
let srvA;
let srvB;

const popupEval = (expr) => chrome.evalIn(chrome.popup, expr);
const status = async () => JSON.parse(await popupEval("chrome.runtime.sendMessage({type:'status'}).then(JSON.stringify)"));
const waitFor = async (what, fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};
// getTargets() also reports the harness's own CDP session as attached, so ask the debugger API instead:
// a command only succeeds when THIS extension holds the tab.
const debuggerAttached = (tabId) =>
  popupEval(`chrome.debugger.sendCommand({ tabId: ${tabId} }, 'Runtime.evaluate', { expression: '1' }).then(() => true, () => false)`);

async function shotPopup(file) {
  const s = chrome.popup;
  await chrome.cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 700, deviceScaleFactor: 2, mobile: false }, s);
  await sleep(450); // let state animations settle
  const rect = JSON.parse(await popupEval("JSON.stringify(document.querySelector('.panel').getBoundingClientRect())"));
  const { data } = await chrome.cdp.send(
    "Page.captureScreenshot",
    { format: "png", clip: { x: 0, y: 0, width: 360, height: Math.ceil(rect.height), scale: 1 } },
    s,
  );
  writeFileSync(path.join(outDir, file), Buffer.from(data, "base64"));
}

try {
  const targetId = await chrome.openPage(`${fixtures.origin}/login`);
  const tabId = await chrome.tabIdFor(fixtures.origin);
  await popupEval(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
  const pageSession = await chrome.attach(targetId);

  // 1. nothing running yet -> popup says so, and arms
  await sleep(600);
  let s = await status();
  check("idle before anything runs", s.state === "idle", JSON.stringify(s));
  await sleep(2800); // popup scan cadence
  await shotPopup("1-idle-no-client.png");

  // 2. start a client; the popup finds it without a typed port
  srvA = await startClient("claude-code");
  const scanMine = async () => JSON.parse(await popupEval("chrome.runtime.sendMessage({type:'scan'}).then(r => JSON.stringify(r.servers))")).filter((x) => ours.has(x.pid));
  const found = await scanMine();
  check("scan finds the first MCP client", found.length === 1 && found[0].client === "claude-code", JSON.stringify(found));
  check("first client took a port in the default range (9470-9480)", found[0]?.port >= 9470 && found[0]?.port <= 9480, String(found[0]?.port));

  // 3. a second client at the same time gets its own port (the old design failed here)
  srvB = await startClient("vscode");
  const found2 = await scanMine();
  check("second MCP client coexists on another port", found2.length === 2 && new Set(found2.map((f) => f.port)).size === 2, JSON.stringify(found2));
  const portB = found2.find((x) => x.pid === srvB.pid)?.port;
  await sleep(2800);
  await shotPopup("2-two-clients.png");

  // 4. connect with NO port: auto-pick, hello + welcome, debugger attaches only now
  const t0 = Date.now();
  s = JSON.parse(await popupEval(`chrome.runtime.sendMessage({type:'connect', tabId:${tabId}, prefer:${portB}}).then(JSON.stringify)`));
  check(`auto connect (no port typed) in ${Date.now() - t0} ms`, s.state === "connected", JSON.stringify(s));
  check("debugger attached once connected", (await debuggerAttached(tabId)) === true);
  await waitFor("welcome frame", async () => (await status()).server?.client, 3000).catch(() => {});
  s = await status();
  check("popup knows which client it is linked to", ["claude-code", "vscode"].includes(s.server?.client), JSON.stringify(s.server));
  const linked = s.server?.client === "claude-code" ? srvA : srvB;
  await waitFor("rtt", async () => (await status()).rttMs !== undefined, 3000).catch(() => {});
  s = await status();
  check(`keepalive measured a round trip (${s.rttMs} ms)`, typeof s.rttMs === "number" && s.rttMs < 250, JSON.stringify(s));

  // 5. tools work, and the AI cursor shows up where the click landed
  let r = await linked.call("browser_snapshot");
  const ref = (re) => txt(r).match(re)?.[1];
  const emailRef = ref(/textbox "Email"[^\n]*\[ref=(e\d+)\]/);
  const submitRef = ref(/button "Submit"[^\n]*\[ref=(e\d+)\]/);
  await linked.call("browser_type", { element: "Email", ref: emailRef, text: "turbo@example.com", submit: false, snapshot: "none" });
  r = await linked.call("browser_click", { element: "Submit", ref: submitRef, snapshot: "none" });
  check("click through the new extension works", !r.isError, txt(r));
  await sleep(150);
  const cursor = JSON.parse(
    await chrome.evalIn(
      pageSession,
      `JSON.stringify((() => { const h = document.getElementsByTagName('jolt-cursor'); const s = h[0] && h[0].__jolt; return { hosts: h.length, x: s && s.x, y: s && s.y, shown: s && s.shown, ariaHidden: h[0] && h[0].getAttribute('aria-hidden'), bodyHasIt: document.body.innerText.includes('jolt') }; })())`,
    ),
  );
  const btn = JSON.parse(await chrome.evalIn(pageSession, `JSON.stringify((() => { const r = document.getElementById('go').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })())`));
  check("exactly one cursor element, hidden from the accessibility tree", cursor.hosts === 1 && cursor.ariaHidden === "true", JSON.stringify(cursor));
  check("cursor sits on the clicked button", Math.abs(cursor.x - btn.x) < 2 && Math.abs(cursor.y - btn.y) < 2, `${JSON.stringify(cursor)} vs ${JSON.stringify(btn)}`);
  check("cursor adds nothing to the page text", cursor.bodyHasIt === false);
  const snap = txt(await linked.call("browser_snapshot"));
  check("snapshot does not mention the cursor", !/jolt-cursor|cursor/i.test(snap) && /Welcome turbo@example\.com/.test(snap), snap);
  const shot = await chrome.cdp.send("Page.captureScreenshot", { format: "png" }, pageSession);
  writeFileSync(path.join(outDir, "3-page-with-ai-cursor.png"), Buffer.from(shot.data, "base64"));

  // 6. cursor setting off removes it and stops drawing
  await popupEval("chrome.storage.local.set({ showCursor: false }).then(() => true)");
  await sleep(300);
  const gone = await chrome.evalIn(pageSession, "document.getElementsByTagName('jolt-cursor').length");
  check("turning the cursor off removes it immediately", gone === 0, String(gone));
  await linked.call("browser_hover", { element: "Submit", ref: submitRef, snapshot: "none" });
  await sleep(150);
  check("and nothing is drawn while it is off", (await chrome.evalIn(pageSession, "document.getElementsByTagName('jolt-cursor').length")) === 0);
  await popupEval("chrome.storage.local.set({ showCursor: true }).then(() => true)");
  await shotPopup("4-connected.png");

  // 7. another browser takes the server's link: automatic retries must NOT steal it back
  const { WebSocket: WS } = await import("ws");
  const linkedPort = (await status()).port;
  const rival = new WS(`ws://127.0.0.1:${linkedPort}`, { origin: "chrome-extension://rival" });
  await new Promise((res, rej) => {
    rival.once("open", res);
    rival.once("error", rej);
  });
  rival.send(JSON.stringify({ type: "hello", payload: { protocolVersion: 2, capabilities: [] } }));
  await waitFor("extension yields to the rival", async () => (await status()).state === "waiting", 5000);
  await sleep(3500); // several retry cycles
  s = await status();
  check("an automatic retry does not steal a link another browser holds", s.state === "waiting" && rival.readyState === WS.OPEN, JSON.stringify(s));
  check("and the tab is not left attached while it waits", (await debuggerAttached(tabId)) === false);
  rival.close();
  const tYield = await waitFor("relink after the rival leaves", async () => (await status()).state === "connected", 15000).catch(() => -1);
  check(`it relinks by itself once the other browser lets go (${tYield} ms)`, tYield >= 0);

  // 8. the linked server goes away; the SAME kind of client comes back, possibly on another port
  const other = linked === srvA ? srvB : srvA;
  await other.client.close();
  if (other === srvA) srvA = undefined;
  else srvB = undefined;
  await sleep(300);
  await linked.client.close();
  if (linked === srvA) srvA = undefined;
  else srvB = undefined;
  const tWait = await waitFor("waiting state", async () => (await status()).state === "waiting", 5000).catch(() => -1);
  check(`extension notices the loss and goes to "waiting" (${tWait} ms)`, tWait >= 0);
  check("debugger is released while no server is there (no stuck banner)", (await debuggerAttached(tabId)) === false);
  await shotPopup("5-reconnecting.png");
  const reborn = await startClient(s.server?.client ?? (linked === srvA ? "claude-code" : "vscode"));
  const tBack = await waitFor("auto reconnect", async () => (await status()).state === "connected", 20000).catch(() => -1);
  s = await status();
  check(`reconnects by itself once a server is back (${tBack} ms, no click)`, tBack >= 0);
  const nowMine = (await scanMine()).find((x) => x.pid === reborn.pid);
  check(`it follows the client to the port it now listens on (:${linkedPort} -> :${s.port})`, !!nowMine && s.port === nowMine.port && s.state === "connected", JSON.stringify({ s, nowMine }));
  r = await reborn.call("browser_snapshot");
  check("tools work after the automatic reconnect", !r.isError && /Welcome|Sign in/.test(txt(r)), txt(r));
  r = await reborn.call("browser_wait_for", { text: "Sign in", timeoutMs: 3000 });
  check("browser_wait_for works right after a reconnect (capabilities already known)", !r.isError, txt(r));
  srvA = reborn;
  srvB = undefined;

  // 9. a deliberate Disconnect is final and releases the tab
  await popupEval("chrome.runtime.sendMessage({type:'disconnect'}).then(() => true)");
  r = await reborn.call("browser_snapshot");
  check("after a deliberate Disconnect, calls fail fast with NO_CONNECTION", r.isError && /NO_CONNECTION/.test(txt(r)), txt(r));
  s = await status();
  check("state is idle after disconnect and the tab is released", s.state === "idle" && (await debuggerAttached(tabId)) === false, JSON.stringify(s));
} catch (e) {
  check("no unexpected exception", false, String(e?.stack ?? e));
} finally {
  await srvA?.client.close().catch(() => {});
  await srvB?.client.close().catch(() => {});
  await chrome.close();
  await fixtures.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed; screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
