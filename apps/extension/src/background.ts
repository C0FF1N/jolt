import { CAPABILITIES, type Cdp, type ConsoleEntry, createHandlers } from "./handlers";

/**
 * MV3 service worker. Connects ONE user-chosen tab to the local MCP server over
 * ws://127.0.0.1:<port>.
 *
 * Lifetime: Chrome stops an idle MV3 worker after ~30 s, and an open-but-quiet
 * WebSocket does not count as activity (only sent/received messages do). So while
 * connected we send a tiny application-level "ping" frame every KEEPALIVE_MS. If the
 * worker is evicted anyway (browser restart, crash) `resume()` rebuilds the socket
 * from chrome.storage.session when the debugger is still attached.
 */

const DEFAULT_PORT = 9009;
const MAX_CONSOLE = 500;
const MAX_RECONNECTS = 8;
const PROTOCOL_VERSION = 2;
const KEEPALIVE_MS = 20_000;

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
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
const consoleBuf: ConsoleEntry[] = [];
const waiters = new Map<string, Set<(params: unknown) => void>>();

/** connect / disconnect / resume must never interleave. */
let opChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

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
  once: (methods, timeoutMs) =>
    new Promise((resolve, reject) => {
      const names = Array.isArray(methods) ? methods : [methods];
      const done = (v: unknown) => {
        cleanup();
        resolve(v);
      };
      const cleanup = () => {
        clearTimeout(timer);
        for (const n of names) waiters.get(n)?.delete(done);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${names.join(" or ")}`));
      }, timeoutMs);
      for (const n of names) {
        const set = waiters.get(n) ?? new Set();
        waiters.set(n, set);
        set.add(done);
      }
    }),
  tab: async () => {
    if (tabId === undefined) throw new Error("No tab is connected");
    const t = await chrome.tabs.get(tabId);
    return { url: t.url ?? "", title: t.title ?? "" };
  },
};

// Recreated on every connect so element refs never carry over between tabs/sessions.
let handlers = createHandlers({ cdp, consoleLog: () => [...consoleBuf] });

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;
  for (const fn of [...(waiters.get(method) ?? [])]) fn(params);
  const p = params as any;
  if (method === "Runtime.consoleAPICalled") {
    const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ");
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
  if (source.tabId === tabId) void serial(disconnectNow);
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) void serial(disconnectNow);
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
  const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : undefined;
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

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = undefined;
}

function startKeepalive(socket: WebSocket) {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, KEEPALIVE_MS);
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
      startKeepalive(socket);
      resolve();
    };
    socket.onmessage = (ev) => void onMessage(ev.data);
    socket.onerror = () =>
      reject(new Error(`Cannot reach the MCP server on 127.0.0.1:${port}. Is it running?`));
    socket.onclose = () => {
      if (ws === socket) {
        ws = undefined;
        stopKeepalive();
      }
      if (wanted && state === "connected") scheduleReconnect();
    };
  });
}

function scheduleReconnect() {
  if (!wanted) return;
  if (reconnectAttempts >= MAX_RECONNECTS) {
    // Give up cleanly: release the tab (no lingering debugger banner) and surface the error.
    void serial(async () => {
      await disconnectNow();
      setState("error", "Lost connection to the MCP server. Start it and click Connect again.");
    });
    return;
  }
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 15_000);
  reconnectAttempts++;
  setState("connecting");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    if (!wanted) return;
    try {
      await openSocket();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

/** True if this extension already holds the debugger on the tab (e.g. after a worker restart). */
async function alreadyOurs(target: number): Promise<boolean> {
  const { session } = (await chrome.storage.session.get("session")) as { session?: Session };
  if (session?.tabId !== target) return false;
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.attached && t.tabId === target);
}

async function connectNow(targetTab: number, targetPort: number) {
  if (state !== "idle") await disconnectNow(); // also cancels a pending reconnect timer
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535) {
    throw new Error("Port must be between 1024 and 65535.");
  }
  setState("connecting");
  consoleBuf.length = 0; // never expose another tab's/session's console output
  handlers = createHandlers({ cdp, consoleLog: () => [...consoleBuf] });
  tabId = targetTab;
  port = targetPort;
  wanted = true;
  try {
    if (!(await alreadyOurs(targetTab))) {
      await chrome.debugger.attach({ tabId: targetTab }, "1.3");
    }
    for (const domain of ["Page", "Runtime", "DOM", "Accessibility", "Log"]) {
      await chrome.debugger.sendCommand({ tabId: targetTab }, `${domain}.enable`);
    }
    await openSocket();
    await chrome.storage.session.set({ session: { tabId: targetTab, port } satisfies Session });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await disconnectNow();
    setState("error", message);
    throw e;
  }
}

async function disconnectNow() {
  wanted = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  stopKeepalive();
  const id = tabId;
  tabId = undefined;
  consoleBuf.length = 0;
  const socket = ws;
  ws = undefined;
  socket?.close();
  if (id !== undefined) await chrome.debugger.detach({ tabId: id }).catch(() => undefined);
  await chrome.storage.session.remove("session").catch(() => undefined);
  waiters.clear();
  reconnectAttempts = 0;
  setState("idle");
}

/** Service worker restarted while a tab was connected: reattach the socket only. */
async function resumeNow() {
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

// Registered before the initial resume so a popup status query is answered after it settles.
const ready = serial(resumeNow);

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  (async () => {
    await ready;
    if (msg?.type === "connect") {
      try {
        await serial(() => connectNow(Number(msg.tabId), msg.port ? Number(msg.port) : DEFAULT_PORT));
      } catch {
        /* surfaced through status */
      }
    } else if (msg?.type === "disconnect") {
      await serial(disconnectNow);
    }
    sendResponse({ state, tabId, error: lastError, port });
  })();
  return true; // async response
});
