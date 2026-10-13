import { CAPABILITIES, type Cdp, type ConsoleEntry, createHandlers } from "./handlers";

/**
 * MV3 service worker. Connects ONE user-chosen tab to the local MCP server over
 * ws://127.0.0.1:<port>. No heartbeat: an active WebSocket keeps the worker
 * alive, and if it is evicted we resume from chrome.storage.session.
 */

const DEFAULT_PORT = 9009;
const MAX_CONSOLE = 500;
const MAX_RECONNECTS = 8;
const PROTOCOL_VERSION = 2;

type State = "idle" | "connecting" | "connected" | "error";
type Session = { tabId: number; port: number };

let state: State = "idle";
let lastError: string | undefined;
let tabId: number | undefined;
let port = DEFAULT_PORT;
let ws: WebSocket | undefined;
let wanted = false; // user intends to stay connected
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
const consoleBuf: ConsoleEntry[] = [];
const waiters = new Map<string, Set<(params: unknown) => void>>();

function pushConsole(entry: ConsoleEntry) {
  consoleBuf.push(entry);
  if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift();
}

function setState(next: State, error?: string) {
  state = next;
  lastError = error;
}

const cdp: Cdp = {
  send: (method, params) => {
    if (tabId === undefined) return Promise.reject(new Error("No tab is connected"));
    return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<any>;
  },
  once: (method, timeoutMs) =>
    new Promise((resolve, reject) => {
      const set = waiters.get(method) ?? new Set();
      waiters.set(method, set);
      const done = (v: unknown) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(v);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      set.add(done);
    }),
  tab: async () => {
    if (tabId === undefined) throw new Error("No tab is connected");
    const t = await chrome.tabs.get(tabId);
    return { url: t.url ?? "", title: t.title ?? "" };
  },
};

const handlers = createHandlers({ cdp, consoleLog: () => [...consoleBuf] });

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  for (const fn of [...(waiters.get(method) ?? [])]) fn(params);
  const p = params as any;
  if (method === "Runtime.consoleAPICalled") {
    const text = (p.args ?? [])
      .map((a: any) => a.value ?? a.description ?? "")
      .join(" ");
    pushConsole({ type: p.type, text: String(text).slice(0, 2000), timestamp: Date.now() });
  } else if (method === "Runtime.exceptionThrown") {
    pushConsole({
      type: "error",
      text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "").slice(0, 2000),
      timestamp: Date.now(),
    });
  } else if (method === "Log.entryAdded") {
    pushConsole({ type: p.entry.level, text: String(p.entry.text).slice(0, 2000), timestamp: Date.now() });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === tabId) void disconnect();
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) void disconnect();
});

function respond(id: string, body: { result?: unknown; error?: string }) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "messageResponse", payload: { requestId: id, ...body } }));
}

async function onMessage(raw: unknown) {
  let msg: { id?: unknown; type?: unknown; payload?: unknown };
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (typeof msg.id !== "string" || typeof msg.type !== "string") return;
  const handler = handlers[msg.type];
  if (!handler) {
    respond(msg.id, { error: `Unsupported message type "${msg.type}"` });
    return;
  }
  const payload =
    msg.payload && typeof msg.payload === "object" ? (msg.payload as Record<string, unknown>) : {};
  try {
    respond(msg.id, { result: await handler(payload) });
  } catch (e) {
    respond(msg.id, { error: e instanceof Error ? e.message : String(e) });
  }
}

function openSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    ws = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          payload: { protocolVersion: PROTOCOL_VERSION, capabilities: [...CAPABILITIES] },
        }),
      );
      reconnectAttempts = 0;
      setState("connected");
      resolve();
    };
    socket.onmessage = (ev) => void onMessage(ev.data);
    socket.onerror = () => reject(new Error(`Cannot reach the MCP server on 127.0.0.1:${port}. Is it running?`));
    socket.onclose = () => {
      if (ws === socket) ws = undefined;
      if (wanted && state === "connected") scheduleReconnect();
    };
  });
}

function scheduleReconnect() {
  if (!wanted || reconnectAttempts >= MAX_RECONNECTS) {
    setState("error", "Lost connection to the MCP server.");
    wanted = false;
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15_000);
  reconnectAttempts++;
  setState("connecting");
  reconnectTimer = setTimeout(async () => {
    try {
      await openSocket();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

async function connect(targetTab: number, targetPort = DEFAULT_PORT) {
  if (state === "connected") await disconnect();
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
    throw new Error("Port must be between 1024 and 65535.");
  }
  setState("connecting");
  tabId = targetTab;
  port = targetPort;
  wanted = true;
  try {
    await chrome.debugger.attach({ tabId: targetTab }, "1.3");
    for (const domain of ["Page", "Runtime", "DOM", "Accessibility", "Log"]) {
      await chrome.debugger.sendCommand({ tabId: targetTab }, `${domain}.enable`);
    }
    await openSocket();
    await chrome.storage.session.set({ session: { tabId: targetTab, port } satisfies Session });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await disconnect();
    setState("error", message);
    throw e;
  }
}

async function disconnect() {
  wanted = false;
  clearTimeout(reconnectTimer);
  const id = tabId;
  tabId = undefined;
  ws?.close();
  ws = undefined;
  if (id !== undefined) await chrome.debugger.detach({ tabId: id }).catch(() => undefined);
  await chrome.storage.session.remove("session").catch(() => undefined);
  waiters.clear();
  if (state !== "error") setState("idle");
}

/** Service worker restarted while a tab was connected: reattach the socket only. */
async function resume() {
  const { session } = (await chrome.storage.session.get("session")) as { session?: Session };
  if (!session) return;
  const targets = await chrome.debugger.getTargets();
  if (!targets.some((t) => t.attached && t.tabId === session.tabId)) {
    await chrome.storage.session.remove("session");
    return;
  }
  tabId = session.tabId;
  port = session.port;
  wanted = true;
  setState("connecting");
  try {
    await openSocket();
  } catch {
    scheduleReconnect();
  }
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "connect") {
      try {
        await connect(Number(msg.tabId), msg.port ? Number(msg.port) : DEFAULT_PORT);
      } catch {
        /* surfaced through status */
      }
    } else if (msg?.type === "disconnect") {
      await disconnect();
    }
    sendResponse({ state, tabId, error: lastError, port });
  })();
  return true; // async response
});

void resume();
