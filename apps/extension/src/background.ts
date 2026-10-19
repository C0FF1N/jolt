import { cursorExpression } from "./cursor";
import { CAPABILITIES, type Cdp, type ConsoleEntry, createHandlers } from "./handlers";
import {
  ARMED_MAX_MS,
  DEFAULT_PORT,
  KEEPALIVE_MS,
  PONG_TIMEOUT_MS,
  WAKE_ALARM,
  backoffMs,
  friendlyAttachError,
  isValidPort,
  pickServer,
} from "./policy";
import { isListening, parseServerInfo, probePort, scanPorts } from "./probe";
import type { ConnState, Push, Request, ServerInfo, Status } from "./types";

/**
 * MV3 service worker. Links ONE user-chosen tab to a local MCP server over ws://127.0.0.1:<port>.
 *
 * Connection model
 *  - Discovery: unless the user pinned a port, scan the server port range (GET /info) and pick a
 *    server (see pickServer). Several MCP clients can run side by side, each on its own port.
 *  - The debugger attaches only once a server answered, and detaches whenever the link drops, so
 *    Chrome's "started debugging this browser" banner means "an agent can drive this tab right now".
 *  - "Armed" (wanted) sessions keep retrying after a drop with a short, jittered backoff, for up to
 *    ARMED_MAX_MS (there is no pairing secret yet, so the wait is bounded). A 30 s chrome.alarm revives
 *    the worker if Chrome evicted it, and the session (also while still waiting for a first server)
 *    lives in chrome.storage.session so a restarted worker picks the tab back up.
 *  - A tiny keepalive ping doubles as a latency probe and dead-server detector.
 */

const MAX_CONSOLE = 500;
const PROTOCOL_VERSION = 2;
const OPEN_TIMEOUT_MS = 3_000;
const SLOW_AFTER_MS = 60_000; // armed with no server ever found: stop scanning every few seconds
const SLOW_RETRY_MS = 30_000;

/** Persisted so a restarted worker resumes: `since` = when the tab was armed or the link last dropped. */
type Session = { tabId: number; port?: number; linked: boolean; since: number; client: string | null };

class NoServerError extends Error {
  constructor(port?: number) {
    super(port ? `No MCP server answered on 127.0.0.1:${port}.` : "No MCP server found.");
  }
}
/** A server is there but another browser holds its link; automatic retries must not steal it. */
class BusyError extends NoServerError {}
class AttachError extends Error {}
const ATTACH_TIMEOUT_MS = 10_000;

/** Reject (as an AttachError) if `p` has not settled in `ms`: a hung page must not wedge the op queue. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttachError(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

let state: ConnState = "idle";
let lastError: string | undefined;
let tabId: number | undefined;
let targetPort: number | undefined; // port to (re)connect to; undefined = scan for one
let userPinned = false;
let preferPort: number | undefined; // popup's pick: tried first among discovered servers, not pinned
let linkedClient: string | null = null; // MCP client name of the server we linked to (to follow it across a port change)
let activePort = DEFAULT_PORT;
let lastPort: number | undefined;
let ws: WebSocket | undefined;
let wanted = false; // the user wants this tab linked
let attempting = false;
let attempt = 0;
let since = 0; // epoch ms: armed, or link last dropped; bounds the wait (ARMED_MAX_MS)
let everLinked = false;
let attachedByUs = false;
let nextRetryAt: number | undefined;
let serverInfo: ServerInfo | undefined;
let rttMs: number | undefined;
let cursorOn = true;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
const consoleBuf: ConsoleEntry[] = [];
const waiters = new Map<string, Set<(params: unknown) => void>>();

/** connect / disconnect / resume / retry must never interleave. */
let opChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => undefined);
  return run;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── status, badge, push ─────────────────────────────────────────────────────────────────────────

function status(): Status {
  const waiting = state === "waiting";
  return {
    state,
    tabId,
    port: activePort,
    pinned: userPinned,
    error: lastError,
    server: serverInfo,
    rttMs,
    attempt: waiting ? attempt : undefined,
    nextRetryAt: waiting ? nextRetryAt : undefined,
  };
}

const BADGE: Record<ConnState, { text: string; bg: string; title: string }> = {
  idle: { text: "", bg: "#475069", title: "Not connected" },
  connecting: { text: "…", bg: "#FFB020", title: "Connecting…" },
  waiting: { text: "…", bg: "#FFB020", title: "Waiting for an MCP client…" },
  connected: { text: "ON", bg: "#C6FF3D", title: "Connected" },
  error: { text: "!", bg: "#FF5C5C", title: "Connection problem" },
};

function publish() {
  const b = BADGE[state];
  void chrome.action.setBadgeText({ text: b.text });
  void chrome.action.setBadgeBackgroundColor({ color: b.bg });
  void chrome.action.setBadgeTextColor({ color: "#0B0D10" });
  void chrome.action.setTitle({ title: `Jolt: ${b.title}` });
  const push: Push = { type: "status", status: status() };
  chrome.runtime.sendMessage(push).catch(() => undefined); // no popup open => no receiver
}

function setState(next: ConnState, error?: string) {
  state = next;
  lastError = error;
  publish();
}

// ── CDP plumbing ────────────────────────────────────────────────────────────────────────────────

function pushConsole(entry: ConsoleEntry) {
  consoleBuf.push(entry);
  if (consoleBuf.length > MAX_CONSOLE) consoleBuf.shift();
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

const newHandlers = () => createHandlers({ cdp, consoleLog: () => [...consoleBuf], showCursor: () => cursorOn });
// Recreated on every connect so element refs never carry over between tabs/sessions.
let handlers = newHandlers();

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

// The user dismissed Chrome's debugging banner (or took the tab over with DevTools): a deliberate stop.
chrome.debugger.onDetach.addListener((source) => {
  const id = source.tabId;
  if (id !== tabId || !attachedByUs) return;
  attachedByUs = false;
  // Re-check inside the queue: by the time it runs the user may have moved on to another tab.
  void serial(async () => {
    if (tabId === id) await disconnectNow();
  });
});
chrome.tabs.onRemoved.addListener((id) => {
  if (id === tabId) {
    void serial(async () => {
      if (tabId === id) await disconnectNow();
    });
  }
});

function saveSession(): Promise<void> {
  if (tabId === undefined) return Promise.resolve();
  const session: Session = { tabId, port: targetPort, linked: everLinked, since, client: linkedClient };
  return chrome.storage.session.set({ session }).catch(() => undefined);
}

/**
 * Does THIS extension hold the debugger on the tab? getTargets().attached is true for any client
 * (DevTools included), so ask the debugger itself: a harmless command only succeeds for the owner.
 */
async function weHold(target: number): Promise<boolean> {
  try {
    await chrome.debugger.sendCommand({ tabId: target }, "Runtime.evaluate", { expression: "0", silent: true });
    return true;
  } catch {
    return false;
  }
}

/** Attach (unless a restarted worker already holds the tab) and enable the CDP domains we use. */
async function prepareTab(target: number): Promise<void> {
  try {
    if (!(await weHold(target))) {
      await chrome.debugger.attach({ tabId: target }, "1.3");
      consoleBuf.length = 0; // enabling domains replays old console output
    }
    attachedByUs = true;
    await Promise.all(
      ["Page", "Runtime", "DOM", "Accessibility", "Log"].map((d) =>
        chrome.debugger.sendCommand({ tabId: target }, `${d}.enable`),
      ),
    );
  } catch (e) {
    throw new AttachError(friendlyAttachError(errText(e)));
  }
}

/** Remove the cursor and let go of the tab (hides Chrome's debugging banner). */
async function releaseTab() {
  const id = tabId;
  if (id === undefined) return;
  if (attachedByUs) {
    // Not awaited: a hung page (open alert()) must never block the detach below.
    chrome.debugger
      .sendCommand({ tabId: id }, "Runtime.evaluate", { expression: cursorExpression("remove", 0, 0), silent: true })
      .catch(() => undefined);
  }
  attachedByUs = false;
  // Always detach (errors ignored): if our flag ever disagreed with reality the banner must still go.
  await chrome.debugger.detach({ tabId: id }).catch(() => undefined);
}

// ── socket ──────────────────────────────────────────────────────────────────────────────────────

function respond(socket: WebSocket, id: string, body: { result?: unknown; error?: string }) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "messageResponse", payload: { requestId: id, ...body } }));
}

async function onFrame(socket: WebSocket, raw: unknown, ready: Promise<void>) {
  let msg: { id?: unknown; type?: unknown; payload?: any };
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (typeof msg.id !== "string") {
    // Notifications from the server (no id): welcome, pong.
    if (msg.type === "welcome") {
      const info = parseServerInfo(msg.payload, activePort); // untrusted: must describe the port we are on
      if (info) {
        serverInfo = info;
        linkedClient = info.client;
        if (everLinked) void saveSession();
        publish();
      }
    } else if (msg.type === "pong") {
      clearTimeout(pongTimer);
      if (typeof msg.payload?.t === "number") {
        rttMs = Math.max(0, Math.round((performance.now() - msg.payload.t) * 10) / 10);
        publish();
      }
    }
    return;
  }
  if (typeof msg.type !== "string") return;
  const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : undefined;
  if (!handler) {
    respond(socket, msg.id, { error: `Unsupported message type "${msg.type}"` });
    return;
  }
  try {
    await ready; // requests can arrive before the debugger is attached
  } catch (e) {
    respond(socket, msg.id, { error: errText(e) });
    return;
  }
  const payload = msg.payload && typeof msg.payload === "object" ? (msg.payload as Record<string, unknown>) : {};
  try {
    respond(socket, msg.id, { result: await handler(payload) });
  } catch (e) {
    respond(socket, msg.id, { error: errText(e) });
  }
}

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  clearTimeout(pongTimer);
  keepaliveTimer = undefined;
  pongTimer = undefined;
}

function ping(socket: WebSocket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "ping", t: performance.now() }));
  // Only servers that introduced themselves (welcome) are known to answer; never penalise older ones.
  if (serverInfo) {
    clearTimeout(pongTimer);
    pongTimer = setTimeout(() => lost(socket), PONG_TIMEOUT_MS);
  }
}

function startKeepalive(socket: WebSocket) {
  stopKeepalive();
  ping(socket);
  keepaliveTimer = setInterval(() => ping(socket), KEEPALIVE_MS);
}

function openSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      socket.onopen = socket.onerror = null;
      socket.close();
      reject(new NoServerError(port));
    }, OPEN_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new NoServerError(port));
    };
  });
}

/** The link dropped (server gone, dead, or restarted): free the tab and start looking again. */
function lost(socket: WebSocket) {
  if (ws !== socket) return;
  ws = undefined;
  stopKeepalive();
  rttMs = undefined;
  try {
    socket.close();
  } catch {
    /* already closed */
  }
  if (!wanted || attempting) return; // an attempt in flight handles its own failure
  since = Date.now(); // the wait for this server starts now
  void saveSession();
  void serial(async () => {
    if (!wanted || ws) return;
    await releaseTab();
    scheduleRetry(); // short, jittered delay: a flapping server must not cause a tight loop
  });
}

// ── connect / retry / disconnect ────────────────────────────────────────────────────────────────

/**
 * Decide which server to link to. Throws NoServerError (nothing there yet) or BusyError (another
 * browser holds that server's link and `takeover` is false).
 */
async function findServer(takeover: boolean): Promise<{ port: number; info?: ServerInfo }> {
  let info: ServerInfo | undefined;
  let port: number;
  if (targetPort === undefined) {
    info = pickServer(await scanPorts(), preferPort ?? lastPort);
    if (!info) throw new NoServerError();
    port = info.port;
  } else {
    port = targetPort;
    info = (await probePort(port)) ?? undefined;
    if (!info && !userPinned && linkedClient) {
      // Our server may be back on another port (a restart takes the lowest free one). Follow the SAME
      // kind of client, never an arbitrary one.
      const same = (await scanPorts()).filter((s) => s.client === linkedClient && (takeover || !s.connected));
      info = pickServer(same);
      if (info) port = info.port;
    }
    // A server without /info (the original Browser MCP) is fine on a port the user chose.
    if (!info && !(await isListening(port))) throw new NoServerError(port);
  }
  // Never steal a live link on an automatic retry: two armed browsers would swap it back and forth.
  if (info?.connected && !takeover) throw new BusyError(port);
  return { port, info };
}

/** `takeover`: the user pressed Connect, so a server another browser is using may be taken over. */
async function attemptConnect(takeover = false): Promise<void> {
  const target = tabId;
  if (target === undefined) throw new Error("No tab is connected");
  attempting = true;
  try {
    // Always ask over HTTP first: a failed WebSocket connect makes Chrome delay the next ones for
    // seconds, so the socket is only opened once we know a server is there (see probe.ts).
    const { port, info } = await findServer(takeover);
    const socket = await openSocket(port);
    serverInfo = info; // refreshed by the server's welcome frame once hello is sent
    linkedClient = info?.client ?? linkedClient;
    ws = socket;
    activePort = port;
    const ready = withTimeout(
      prepareTab(target),
      ATTACH_TIMEOUT_MS,
      "The page did not respond to the debugger. Close any open dialog on it and try again.",
    );
    ready.catch(() => undefined); // surfaced below and per request; never an unhandled rejection
    socket.onmessage = (ev) => void onFrame(socket, ev.data, ready);
    socket.onclose = socket.onerror = () => lost(socket);
    // Announce capabilities right away (they do not depend on the attach): a tool call parked in the
    // server's grace wait wakes at socket open and must already see them. Requests wait on `ready`.
    socket.send(
      JSON.stringify({ type: "hello", payload: { protocolVersion: PROTOCOL_VERSION, capabilities: [...CAPABILITIES] } }),
    );
    try {
      await ready;
    } catch (e) {
      ws = undefined;
      socket.onclose = socket.onerror = null;
      socket.close();
      throw e;
    }
    if (ws !== socket) throw new NoServerError(port); // dropped while attaching
    targetPort = port; // stay on this server from now on
    everLinked = true;
    attempt = 0;
    nextRetryAt = undefined;
    lastPort = port;
    startKeepalive(socket);
    since = Date.now();
    await saveSession();
    await chrome.storage.local.set({ lastPort: port });
    if (ws !== socket) throw new NoServerError(port); // dropped during the awaits above
    setState("connected");
  } catch (e) {
    // Dropped mid-attach: do not leave the debugger on the tab while the UI says "waiting".
    if (e instanceof NoServerError) await releaseTab();
    throw e;
  } finally {
    attempting = false;
  }
}

function scheduleRetry(immediate = false) {
  if (!wanted) return;
  clearTimeout(retryTimer);
  const slow = !everLinked && !userPinned && Date.now() - since > SLOW_AFTER_MS;
  const delay = immediate ? 0 : slow ? SLOW_RETRY_MS : backoffMs(attempt);
  if (!immediate) attempt++;
  nextRetryAt = Date.now() + delay;
  setState("waiting");
  retryTimer = setTimeout(() => void serial(retryNow), delay);
}

async function retryNow() {
  if (!wanted || ws || attempting) return;
  clearTimeout(retryTimer);
  if (Date.now() - since > ARMED_MAX_MS) {
    const mins = Math.round(ARMED_MAX_MS / 60_000);
    await failHard(
      everLinked
        ? `The MCP client has been gone for ${mins} minutes, so this tab was released. Press Connect when you are ready.`
        : `No MCP client started within ${mins} minutes, so this tab was released. Press Connect to try again.`,
    );
    return;
  }
  try {
    await attemptConnect();
  } catch (e) {
    if (!wanted) return;
    if (e instanceof NoServerError) scheduleRetry();
    else await failHard(errText(e));
  }
}

async function failHard(message: string) {
  await disconnectNow();
  setState("error", message);
}

async function connectNow(targetTab: number, requestedPort?: number, prefer?: number) {
  if (wanted || state !== "idle") await disconnectNow(); // switching tabs/servers
  if (requestedPort !== undefined && !isValidPort(requestedPort)) {
    throw new Error("Port must be between 1024 and 65535.");
  }
  consoleBuf.length = 0; // never expose another tab's/session's console output
  handlers = newHandlers();
  tabId = targetTab;
  targetPort = requestedPort;
  userPinned = requestedPort !== undefined;
  preferPort = isValidPort(prefer) ? prefer : undefined;
  activePort = requestedPort ?? preferPort ?? lastPort ?? DEFAULT_PORT;
  wanted = true;
  attempt = 0;
  since = Date.now();
  everLinked = false;
  linkedClient = null;
  serverInfo = undefined;
  await saveSession(); // so "Connect and wait" survives Chrome evicting the worker
  await chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
  setState("connecting");
  try {
    await attemptConnect(true);
  } catch (e) {
    if (e instanceof NoServerError) {
      scheduleRetry(); // armed: the tab joins the moment a server appears
      return;
    }
    await failHard(errText(e));
    throw e;
  }
}

async function disconnectNow() {
  wanted = false;
  clearTimeout(retryTimer);
  retryTimer = undefined;
  nextRetryAt = undefined;
  stopKeepalive();
  const socket = ws;
  ws = undefined;
  if (socket) {
    try {
      // Tells the server this was on purpose, so it does not wait around for a reconnect.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "bye" }));
    } catch {
      /* closing anyway */
    }
    socket.onclose = socket.onerror = null;
    socket.close();
  }
  await releaseTab();
  tabId = undefined;
  targetPort = undefined;
  userPinned = false;
  preferPort = undefined;
  linkedClient = null;
  serverInfo = undefined;
  rttMs = undefined;
  everLinked = false;
  attempt = 0;
  consoleBuf.length = 0;
  waiters.clear();
  await chrome.storage.session.remove("session").catch(() => undefined);
  await chrome.alarms.clear(WAKE_ALARM).catch(() => undefined);
  setState("idle");
}

/** Worker restarted (or Chrome woke it) while a tab was armed or linked: pick the tab back up. */
async function resumeNow() {
  if (wanted) return;
  const { session } = (await chrome.storage.session.get("session")) as { session?: Session };
  const tab = session ? await chrome.tabs.get(session.tabId).catch(() => undefined) : undefined;
  if (!session || !tab) {
    // Nothing to resume: make sure the wake-up alarm does not keep firing for a session that is gone.
    if (session) await chrome.storage.session.remove("session");
    await chrome.alarms.clear(WAKE_ALARM).catch(() => undefined);
    return;
  }
  tabId = session.tabId;
  targetPort = session.port;
  linkedClient = session.client ?? null;
  activePort = session.port ?? lastPort ?? DEFAULT_PORT;
  wanted = true;
  everLinked = session.linked;
  since = session.since;
  attempt = 0;
  handlers = newHandlers();
  attachedByUs = await weHold(session.tabId);
  scheduleRetry(true);
}

// ── events ──────────────────────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WAKE_ALARM) return;
  void serial(async () => {
    await resumeNow();
    await retryNow();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.showCursor) return;
  cursorOn = changes.showCursor.newValue !== false;
  if (!cursorOn && attachedByUs) {
    cdp.send("Runtime.evaluate", { expression: cursorExpression("remove", 0, 0), silent: true }).catch(() => undefined);
  }
});

// Registered before the initial resume so a popup status query is answered after it settles.
const ready = serial(async () => {
  const saved = (await chrome.storage.local.get(["showCursor", "lastPort"])) as { showCursor?: boolean; lastPort?: number };
  cursorOn = saved.showCursor !== false;
  lastPort = isValidPort(saved.lastPort) ? saved.lastPort : undefined;
  await resumeNow();
  publish();
}).catch(() => undefined); // a failed init must not leave the popup waiting forever

chrome.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg?.type) {
      case "connect":
        try {
          await serial(() =>
            connectNow(Number(msg.tabId), msg.port ? Number(msg.port) : undefined, msg.prefer ? Number(msg.prefer) : undefined),
          );
        } catch {
          /* surfaced through status */
        }
        break;
      case "disconnect":
        await serial(disconnectNow);
        break;
      case "retry":
        await serial(retryNow);
        break;
      case "scan":
        sendResponse({ ...status(), servers: await scanPorts() });
        return;
      case "status":
        if (ws && state === "connected") ping(ws); // fresh latency for the popup
        break;
    }
    sendResponse(status());
  })();
  return true; // async response
});
