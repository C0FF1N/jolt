/** Shapes shared by the service worker and the popup. */

/** What a server announces about itself (probe reply and `welcome` frame). */
export type ServerInfo = {
  name: string;
  version: string;
  protocolVersion: number;
  pid: number;
  port: number;
  startedAt: number;
  /** MCP client that launched this server, e.g. "claude-code"; null until its handshake finishes. */
  client: string | null;
  /** True when some extension already holds this server's single browser link. */
  connected: boolean;
};

export type ConnState = "idle" | "connecting" | "connected" | "waiting" | "error";

export type Status = {
  state: ConnState;
  tabId?: number;
  /** Port in use, or the pinned/last port while waiting. */
  port: number;
  /** True when the user fixed a port instead of letting the extension find a server. */
  pinned: boolean;
  error?: string;
  /** Who we are linked to (from the server's welcome frame). */
  server?: ServerInfo;
  /** Last measured round trip to the server, in ms. */
  rttMs?: number;
  /** While waiting: which attempt this is and when the next one fires (epoch ms). */
  attempt?: number;
  nextRetryAt?: number;
};

/** popup -> service worker */
export type Request =
  | { type: "status" }
  | { type: "scan" }
  /** `port` = the user typed a fixed port; `prefer` = which discovered server to try first (not pinned). */
  | { type: "connect"; tabId: number; port?: number; prefer?: number }
  | { type: "disconnect" }
  | { type: "retry" };

/** service worker -> popup (push) */
export type Push = { type: "status"; status: Status };
