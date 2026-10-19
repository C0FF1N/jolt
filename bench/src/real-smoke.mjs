// Real-browser functional check: new extension + Jolt server + fixture pages.
// Usage: node src/real-smoke.mjs [--target=turbo|baseline] [--headed]
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
const target = args.target ?? "turbo";
const entry = path.join(root, target === "baseline" ? "baseline" : "apps/server", "dist/index.js");
const port = 19511;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
};
const txt = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const refOf = (snapshot, re) => snapshot.match(re)?.[1];

const fixtures = await startFixtureServer();
const chrome = await launchChrome({
  extensionDir: path.join(root, "apps/extension/dist"),
  headless: !args.headed,
});
console.log(`chromium ${chrome.version}, extension ${chrome.extensionId}, server=${target}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { ...process.env, JOLT_PORT: String(port) },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const call = (name, a = {}) => client.callTool({ name, arguments: a }, undefined, { timeout: 30000 });

try {
  await new Promise((r) => setTimeout(r, 300));
  await chrome.openPage(`${fixtures.origin}/login`);
  const tabId = await chrome.tabIdFor(fixtures.origin);
  const status = await chrome.connectTab(tabId, port);
  check("extension connects the chosen tab", status.state === "connected", JSON.stringify(status));

  let r = await call("browser_snapshot");
  let s = txt(r);
  check("snapshot has url/title/tree", s.includes("Page Title: Login") && s.includes("textbox"), s.slice(0, 400));
  const emailRef = refOf(s, /textbox "Email"[^\n]*\[ref=(e\d+)\]/);
  const btnRef = refOf(s, /button "Submit"[^\n]*\[ref=(e\d+)\]/);
  check("snapshot exposes refs for textbox and button", Boolean(emailRef && btnRef), s);

  r = await call("browser_type", { element: "Email", ref: emailRef, text: "real@example.com", submit: false });
  check("type succeeds", !r.isError, txt(r));
  r = await call("browser_click", { element: "Submit", ref: btnRef });
  s = txt(r);
  check("click updates the page (sees Welcome)", s.includes("Welcome real@example.com"), s);

  r = await call("browser_click", { element: "Ghost", ref: "e9999" });
  check("unknown ref returns an actionable error", r.isError && /snapshot/i.test(txt(r)), txt(r));

  r = await call("browser_navigate", { url: `${fixtures.origin}/slow` });
  check("navigate returns a snapshot of the new page", txt(r).includes("Slow page"), txt(r).slice(0, 300));

  if (target === "turbo") {
    const t0 = Date.now();
    r = await call("browser_wait_for", { text: "Loaded", timeoutMs: 5000 });
    check("wait_for text on slow page (event-driven)", !r.isError, txt(r));
    console.log(`      waited ${Date.now() - t0} ms (page content appears after ~800 ms)`);
    r = await call("browser_wait_for", { text: "Never", timeoutMs: 400 });
    check("wait_for timeout names the condition", r.isError && /Never/.test(txt(r)), txt(r));

    await call("browser_navigate", { url: `${fixtures.origin}/login` });
    s = txt(await call("browser_snapshot"));
    const e2 = refOf(s, /textbox "Email"[^\n]*\[ref=(e\d+)\]/);
    const b2 = refOf(s, /button "Submit"[^\n]*\[ref=(e\d+)\]/);
    r = await call("browser_batch", {
      finalSnapshot: "full",
      actions: [
        { action: "type", element: "Email", ref: e2, text: "batch@example.com" },
        { action: "click", element: "Submit", ref: b2 },
        { action: "wait_for", text: "Welcome batch@example.com", timeoutMs: 3000 },
      ],
    });
    const outcome = JSON.parse(r.content[0].text);
    check("batch: type + click + wait_for in one call", outcome.ok && outcome.completed === 3, r.content[0].text);
    check("batch final snapshot shows the result", txt(r).includes("Welcome batch@example.com"));

    await call("browser_navigate", { url: `${fixtures.origin}/large` });
    r = await call("browser_snapshot", { maxChars: 2000 });
    s = txt(r);
    check("large page snapshot is bounded with a continuation note", /Snapshot truncated/.test(s) && s.length < 4000, s.slice(-300));
    const off = s.match(/offset=(\d+)/)?.[1];
    r = await call("browser_snapshot", { maxChars: 2000, offset: Number(off) });
    check("continuation returns the next chunk", /Item/.test(txt(r)) && !txt(r).includes("Item 0 "), txt(r).slice(0, 200));

    await call("browser_navigate", { url: `${fixtures.origin}/spa` });
    s = txt(await call("browser_snapshot"));
    const nref = refOf(s, /button "Next view"[^\n]*\[ref=(e\d+)\]/);
    await call("browser_click", { element: "Next view", ref: nref, snapshot: "none" });
    r = await call("browser_wait_for", { text: "View two", timeoutMs: 3000 });
    check("SPA transition: wait_for the new view", !r.isError, txt(r));
  }

  r = await call("browser_get_console_logs");
  check("console logs call works", !r.isError, txt(r));
  r = await call("browser_screenshot");
  check("screenshot returns an image", r.content?.[0]?.type === "image" && r.content[0].data.length > 100);

  await chrome.disconnect();
  r = await call("browser_snapshot");
  check("after disconnect, tools fail with a clear error (no hang)", r.isError, txt(r));
} catch (e) {
  check("no unexpected exception", false, String(e?.stack ?? e));
} finally {
  await client.close().catch(() => {});
  await chrome.close();
  await fixtures.close();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
