import { DEFAULT_PORT, friendlyClientName, isValidPort, pickServer } from "./policy";
import type { Push, Request, ServerInfo, Status } from "./types";
import { type ClientRow, clientRows, describe } from "./view-model";

const SCAN_EVERY_MS = 2_500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  hero: $("hero"),
  title: $("title"),
  sub: $("sub"),
  rtt: $("rtt"),
  rttv: $("rttv"),
  tabcard: $("tabcard"),
  mono: $("mono"),
  tabtitle: $("tabtitle"),
  tabhost: $("tabhost"),
  clientsWrap: $("clients-wrap"),
  clients: $("clients"),
  empty: $("empty"),
  primary: $<HTMLButtonElement>("primary"),
  retry: $<HTMLButtonElement>("retry"),
  hint: $("hint"),
  cursor: $<HTMLInputElement>("cursor"),
  port: $<HTMLInputElement>("port"),
  ver: $("ver"),
};

let status: Status = { state: "idle", port: DEFAULT_PORT, pinned: false };
let servers: ServerInfo[] = [];
let selectedPort: number | undefined;
let lastPort: number | undefined;
let activeTab: chrome.tabs.Tab | undefined;
let subjectTab: chrome.tabs.Tab | undefined;
let clientsSig = "";
let busy = false;
/** Keep the user's own choice sticky; until they click, follow the default (newest / current). */
let userPicked = false;

const ask = <T>(msg: Request) => chrome.runtime.sendMessage(msg) as Promise<T>;

function ensureSelection() {
  if (userPicked && servers.some((s) => s.port === selectedPort)) return;
  const prefer = status.state === "connected" ? status.port : lastPort;
  selectedPort = pickServer(servers, prefer)?.port;
}

function renderClients(rows: ClientRow[]) {
  const sig = JSON.stringify(rows);
  if (sig === clientsSig) return;
  clientsSig = sig;
  el.clients.replaceChildren(
    ...rows.map((r) => {
      const label = document.createElement("label");
      label.className = "client";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "client";
      input.value = String(r.port);
      input.checked = r.selected;
      input.addEventListener("change", () => {
        userPicked = true;
        selectedPort = r.port;
        render();
      });
      const pip = document.createElement("span");
      pip.className = "pip";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = r.meta;
      label.append(input, pip, name, meta);
      if (r.current) {
        const live = document.createElement("span");
        live.className = "live";
        live.textContent = "LIVE";
        label.append(live);
      }
      return label;
    }),
  );
}

function renderTab() {
  const tab = subjectTab;
  const show = !!tab?.url && /^https?:/i.test(tab.url);
  el.tabcard.hidden = !show;
  if (!show || !tab) return;
  el.tabtitle.textContent = tab.title || tab.url || "";
  try {
    el.tabhost.textContent = new URL(tab.url!).host;
  } catch {
    el.tabhost.textContent = "";
  }
  // A local monogram instead of the page's favicon: loading that would tell the page you opened the popup.
  el.mono.textContent = (el.tabhost.textContent ?? "").replace(/^www./i, "").charAt(0) || "·";
}

function render() {
  ensureSelection();
  const view = describe({ status, servers, activeTab, now: Date.now() });
  el.hero.dataset.tone = view.tone;
  el.title.textContent = view.title;
  el.sub.textContent = view.sub;
  el.rtt.hidden = !view.showRtt;
  if (view.showRtt && status.rttMs !== undefined) {
    el.rttv.textContent = status.rttMs < 10 ? status.rttMs.toFixed(1) : String(Math.round(status.rttMs));
  }

  const rows = clientRows(servers, status, selectedPort);
  renderClients(rows);
  el.empty.hidden = rows.length > 0;
  el.clientsWrap.hidden = status.state === "waiting" && rows.length === 0;

  const here = status.tabId !== undefined && status.tabId === activeTab?.id;
  let primary = view.primary;
  let secondary = view.secondary;
  // The user chose a different client than the one we are linked to / waiting for: offer to move.
  const chosen = userPicked && selectedPort !== status.port ? servers.find((s) => s.port === selectedPort) : undefined;
  if (chosen && (status.state === "waiting" || (status.state === "connected" && here))) {
    const live = status.state === "connected";
    const name = friendlyClientName(chosen.client);
    primary = { action: live ? "switch" : "connect", label: live ? `Switch to ${name}` : `Connect to ${name}`, disabled: false };
    secondary = { action: "disconnect", label: live ? "Disconnect" : "Stop", disabled: false };
  }
  el.primary.textContent = primary.label;
  el.primary.dataset.action = primary.action;
  el.primary.disabled = primary.disabled || busy;
  el.retry.hidden = !secondary;
  if (secondary) {
    el.retry.textContent = secondary.label;
    el.retry.dataset.action = secondary.action;
    el.retry.disabled = secondary.disabled || busy;
  }
  el.hint.hidden = !view.hint;
  el.hint.textContent = view.hint ?? "";
  renderTab();
}

async function refreshTabs() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  subjectTab =
    status.tabId !== undefined && status.tabId !== activeTab?.id
      ? await chrome.tabs.get(status.tabId).catch(() => activeTab)
      : activeTab;
}

async function refreshServers() {
  try {
    const r = await ask<Status & { servers: ServerInfo[] }>({ type: "scan" });
    servers = r.servers;
    status = { ...r };
    delete (status as Partial<typeof r>).servers;
  } catch {
    /* service worker restarting: next tick */
  }
  await refreshTabs();
  render();
}

async function run(action: string) {
  if (busy) return;
  busy = true;
  render();
  try {
    if (action === "disconnect") {
      status = await ask<Status>({ type: "disconnect" });
    } else if (action === "retry") {
      status = await ask<Status>({ type: "retry" });
    } else if (action === "connect" || action === "switch") {
      const typed = el.port.value.trim() === "" ? undefined : Number(el.port.value);
      if (typed !== undefined && !isValidPort(typed)) {
        el.hint.hidden = false;
        el.hint.textContent = "Port must be between 1024 and 65535.";
        return;
      }
      // Only a typed port is pinned; a picked row is just "try this one first", so the link can still
      // follow the same client if a restart moves it to another port.
      const prefer = typed === undefined && servers.length > 0 ? selectedPort : undefined;
      if (activeTab?.id !== undefined) {
        status = await ask<Status>({ type: "connect", tabId: activeTab.id, port: typed, prefer });
      }
    }
    await refreshTabs();
  } finally {
    busy = false;
    render();
  }
}

el.primary.addEventListener("click", () => void run(el.primary.dataset.action ?? ""));
el.retry.addEventListener("click", () => void run(el.retry.dataset.action ?? ""));
el.cursor.addEventListener("change", () => void chrome.storage.local.set({ showCursor: el.cursor.checked }));
el.port.addEventListener("change", () => {
  const v = el.port.value.trim();
  void chrome.storage.local.set({ fixedPort: v === "" ? null : Number(v) });
});

chrome.runtime.onMessage.addListener((m: Push) => {
  if (m?.type !== "status") return;
  status = m.status;
  void refreshTabs().then(render);
});

void (async () => {
  el.ver.textContent = `v${chrome.runtime.getManifest().version}`;
  const saved = (await chrome.storage.local.get(["showCursor", "fixedPort", "lastPort"])) as {
    showCursor?: boolean;
    fixedPort?: number | null;
    lastPort?: number;
  };
  el.cursor.checked = saved.showCursor !== false;
  if (isValidPort(saved.fixedPort)) {
    el.port.value = String(saved.fixedPort);
    (el.port.closest("details") as HTMLDetailsElement | null)?.setAttribute("open", "");
  }
  lastPort = isValidPort(saved.lastPort) ? saved.lastPort : undefined;
  status = await ask<Status>({ type: "status" });
  await refreshTabs();
  render();
  await refreshServers();
  setInterval(() => void refreshServers(), SCAN_EVERY_MS);
  setInterval(() => status.state === "waiting" && render(), 1_000); // retry countdown
})();
