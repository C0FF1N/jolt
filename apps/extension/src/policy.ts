import type { ServerInfo } from "./types";

/** First port of the range servers pick from. Keep in sync with packages/config mcp.config.ts. */
export const DEFAULT_PORT = 9470;
export const PORT_SCAN_COUNT = 11;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export const KEEPALIVE_MS = 15_000;
/** A server that answered `welcome` must answer a ping within this, or the link is considered dead. */
export const PONG_TIMEOUT_MS = 8_000;
export const WAKE_ALARM = "jolt-wake";
/**
 * How long an armed tab keeps waiting for its server (counted from arming, or from the last time the
 * link dropped) before the tab is released. There is no pairing secret yet, so an unbounded wait
 * would let any local process that later binds the port inherit the tab; this bounds that window.
 */
export const ARMED_MAX_MS = 15 * 60_000;

export const isValidPort = (p: unknown): p is number =>
  typeof p === "number" && Number.isInteger(p) && p >= MIN_PORT && p <= MAX_PORT;

export const portRange = (base = DEFAULT_PORT, count = PORT_SCAN_COUNT): number[] =>
  Array.from({ length: count }, (_, i) => base + i).filter(isValidPort);

/**
 * Delay before reconnect attempt `attempt` (0-based). Quick at first (a server bounce takes ~1 s),
 * then settles at ~5 s. Jitter keeps several browser windows from retrying in lockstep.
 */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(400 * 1.7 ** attempt, 5_000);
  return Math.round(base * (0.85 + rand() * 0.3));
}

/**
 * Which server to use when several are running: the one the user used last if it is still up,
 * otherwise the newest (the client they just launched), otherwise the lowest port.
 */
export function pickServer(found: ServerInfo[], preferredPort?: number): ServerInfo | undefined {
  if (found.length === 0) return undefined;
  const preferred = found.find((s) => s.port === preferredPort);
  if (preferred) return preferred;
  return [...found].sort((a, b) => b.startedAt - a.startedAt || a.port - b.port)[0];
}

/** "claude-code" -> "Claude Code", "Visual Studio Code" -> "VS Code", unknown names pass through. */
export function friendlyClientName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return "MCP client";
  if (/claude[-_\s]?code/i.test(name)) return "Claude Code";
  // VS Code forks announce themselves as "<fork>-vscode", so match them before plain VS Code.
  if (/cursor/i.test(name)) return "Cursor";
  if (/windsurf/i.test(name)) return "Windsurf";
  if (/visual studio code|vs[-_\s]?code/i.test(name)) return "VS Code";
  if (/claude/i.test(name)) return "Claude Desktop";
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

/** Pages Chrome refuses to let any extension debug. */
export function isAutomatable(url: string | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !/^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
}

/** chrome.debugger.attach errors, in words a person can act on. */
export function friendlyAttachError(message: string): string {
  if (/another debugger is already attached/i.test(message)) {
    return "Another debugger (DevTools or an extension) is attached to this tab. Close it and connect again.";
  }
  if (/cannot access|cannot attach|not allowed/i.test(message)) {
    return "Chrome doesn't allow automation on this page. Switch to a normal website tab.";
  }
  if (/no tab with given id|no such tab/i.test(message)) return "That tab was closed.";
  return message;
}
