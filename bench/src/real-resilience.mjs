// Real-browser resilience checks (new extension + Jolt server).
// Usage: node src/real-resilience.mjs [--idle=75]   (idle seconds; default 75 > Chrome's ~30 s MV3 idle limit)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "./chrome.mjs";
import { startFixtureServer } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = "true"] = a.replace(/^--/, "").split("=");
  return [k, v];
}));
const idleSeconds = Number(args.idle ?? 75);
const entry = path.join(root, "apps/server/dist/index.js");
const port = 19711;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const refOf = (s, re) => s.match(re)?.[1];

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};

async function startClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, JOLT_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "resilience", version: "0" });
  await client.connect(transport);
  await sleep(300);
  return {
    client,
    call: (name, a = {}) => client.callTool({ name, arguments: a }, undefined, { timeout: 30000 }),
  };
}

const fixtures = await startFixtureServer();
const chrome = await launchChrome({ extensionDir: process.env.JOLT_EXT_DIR ?? path.join(root, "apps/extension/dist") });
console.log(`chromium ${chrome.version}`);
let srv = await startClient();

try {
  await chrome.openPage(`${fixtures.origin}/login`);
  const tabId = await chrome.tabIdFor(fixtures.origin);
  const status = await chrome.connectTab(tabId, port);
  check("connect", status.state === "connected", JSON.stringify(status));

  let s = txt(await srv.call("browser_snapshot"));
  const email = refOf(s, /textbox "Email"[^\n]*\[ref=(e\d+)\]/);

  // --- key chords and clearing a field -------------------------------------------------
  await srv.call("browser_type", { element: "Email", ref: email, text: "hello world", submit: false, snapshot: "none" });
  s = txt(await srv.call("browser_snapshot"));
  check("typed value is visible in the snapshot", /\[value="hello world"\]/.test(s), s);
  let r = await srv.call("browser_press_key", { key: "Control+a" });
  check("press_key accepts a modifier chord (Control+a)", !r.isError, txt(r));
  r = await srv.call("browser_press_key", { key: "F5" });
  check("press_key accepts a function key name (F5)", !r.isError, txt(r));
  await sleep(500); // F5 reloads the page: refs are gone, take a new snapshot
  s = txt(await srv.call("browser_snapshot"));
  const email2 = refOf(s, /textbox "Email"[^\n]*\[ref=(e\d+)\]/);
  await srv.call("browser_type", { element: "Email", ref: email2, text: "to be cleared", submit: false, snapshot: "none" });
  await srv.call("browser_type", { element: "Email", ref: email2, text: "", submit: false, snapshot: "none" });
  s = txt(await srv.call("browser_snapshot"));
  check("typing empty text clears the field", !/\[value=/.test(s.split("\n").find((l) => l.includes('textbox "Email"')) ?? ""), s);

  // --- SPA same-document navigation must not stall --------------------------------------
  await srv.call("browser_navigate", { url: `${fixtures.origin}/spa`, snapshot: "none" });
  s = txt(await srv.call("browser_snapshot"));
  const next = refOf(s, /button "Next view"[^\n]*\[ref=(e\d+)\]/);
  await srv.call("browser_click", { element: "Next view", ref: next, snapshot: "none" });
  await srv.call("browser_wait_for", { text: "View two", timeoutMs: 3000 });
  const t0 = Date.now();
  r = await srv.call("browser_go_back", { snapshot: "none" });
  const backMs = Date.now() - t0;
  check(`go_back inside an SPA returns promptly (${backMs} ms, cap was 15000)`, !r.isError && backMs < 5000, txt(r));

  // --- idle survival ------------------------------------------------------------------------
  console.log(`      idling ${idleSeconds}s (MV3 workers are evicted after ~30s without messages)...`);
  await sleep(idleSeconds * 1000);
  r = await srv.call("browser_snapshot");
  check(`connection survives ${idleSeconds}s of idle`, !r.isError, txt(r));

  // --- server restart: extension reconnects by itself ---------------------------------
  await srv.client.close();
  await sleep(500);
  srv = await startClient();
  let recovered = false;
  const tr = Date.now();
  for (let i = 0; i < 20 && !recovered; i++) {
    await sleep(1000);
    const x = await srv.call("browser_get_console_logs");
    recovered = !x.isError;
  }
  check(`extension reconnects after a server restart (${Date.now() - tr} ms)`, recovered);
  r = await srv.call("browser_snapshot");
  check("tools work after the automatic reconnect", !r.isError, txt(r));

  // --- tab closure ---------------------------------------------------------------------------
  await chrome.closeTab(tabId);
  await sleep(700);
  r = await srv.call("browser_snapshot");
  check("closing the tab gives a clear error (no hang)", r.isError && /NO_CONNECTION|DISCONNECTED|TIMEOUT/.test(txt(r)), txt(r));
} catch (e) {
  check("no unexpected exception", false, String(e?.stack ?? e));
} finally {
  await srv.client.close().catch(() => {});
  await chrome.close();
  await fixtures.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
