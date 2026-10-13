// Launches a real (Playwright) Chromium with the built extension loaded, using a
// throw-away profile, and exposes a tiny CDP client + extension control helpers.
// Never touches the user's own Chrome profiles.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

export function findChromium() {
  if (process.env.BROWSERMCP_BENCH_CHROME) return process.env.BROWSERMCP_BENCH_CHROME;
  const base = path.join(os.homedir(), "AppData/Local/ms-playwright");
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const exe = path.join(base, d, "chrome-win64", "chrome.exe");
    if (existsSync(exe)) return exe;
  }
  return null;
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const p = m.id && this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome({ extensionDir, debugPort = 19222, headless = true }) {
  const exe = findChromium();
  if (!exe) throw new Error("No Playwright Chromium found (set BROWSERMCP_BENCH_CHROME).");
  const profile = mkdtempSync(path.join(os.tmpdir(), "bmcp-bench-"));
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      ...(headless ? ["--headless"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch {
      await sleep(100);
    }
  }
  if (!version) throw new Error("Chromium did not expose a debugging endpoint");
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  const cdp = new CdpClient(ws);

  const attach = async (targetId) =>
    (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const evalIn = async (sessionId, expression) => {
    const r = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };

  // Find OUR extension among the browser's service workers (Chromium ships component
  // extensions too) by manifest name, then open its popup page from its own worker:
  // navigating to a chrome-extension:// URL directly is blocked.
  let extensionId;
  let sw;
  const swSessions = [];
  for (let i = 0; i < 100 && !extensionId; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      try {
        const session = await attach(t.targetId);
        swSessions.push(session);
        const name = await evalIn(session, "chrome.runtime.getManifest().name");
        if (name === "Browser MCP Turbo (unofficial)") {
          extensionId = new URL(t.url).host;
          sw = session;
          break;
        }
      } catch {}
    }
    if (!extensionId) await sleep(150);
  }
  if (!extensionId) throw new Error("Extension service worker did not start (extension failed to load?)");

  await evalIn(sw, "chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }).then(t => t.id)");
  let popup;
  for (let i = 0; i < 100 && !popup; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find((t) => t.type === "page" && t.url === `chrome-extension://${extensionId}/popup.html`);
    if (t) popup = await attach(t.targetId);
    else await sleep(100);
  }
  if (!popup) throw new Error("Extension popup page did not open");
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = await evalIn(popup, "typeof chrome !== 'undefined' && !!chrome.tabs && !!chrome.runtime.sendMessage");
    } catch {}
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error("Extension popup page never exposed chrome.tabs");
  // An attached DevTools session keeps a service worker alive, which would hide idle-eviction
  // behaviour; detach every worker session now that setup is done.
  for (const sessionId of swSessions) {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  return {
    exe,
    version: version.Browser,
    extensionId,
    async openPage(url) {
      const { targetId } = await cdp.send("Target.createTarget", { url });
      return targetId;
    },
    async tabIdFor(urlPrefix) {
      for (let i = 0; i < 50; i++) {
        const tabs = JSON.parse(
          await evalIn(popup, "chrome.tabs.query({}).then(t => JSON.stringify(t.map(x => ({id: x.id, url: x.url}))))"),
        );
        const hit = tabs.find((t) => t.url.startsWith(urlPrefix));
        if (hit) return hit.id;
        await sleep(100);
      }
      throw new Error(`No tab for ${urlPrefix}`);
    },
    async connectTab(tabId, port) {
      const status = await evalIn(
        popup,
        `chrome.runtime.sendMessage({type:'connect', tabId:${tabId}, port:${port}}).then(JSON.stringify)`,
      );
      return JSON.parse(status);
    },
    async closeTab(tabId) {
      await evalIn(popup, `chrome.tabs.remove(${Number(tabId)}).then(() => true)`);
    },
    async disconnect() {
      await evalIn(popup, "chrome.runtime.sendMessage({type:'disconnect'}).then(JSON.stringify)");
    },
    async close() {
      try { ws.close(); } catch {}
      try { execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      await sleep(500);
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}
