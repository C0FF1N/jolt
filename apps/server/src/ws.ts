import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import { env } from "@repo/config/env";
import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import { killProcessOnPort } from "@/utils/port";

const LOOPBACK = "127.0.0.1";

/** Origins that may open the socket: the extension itself (or no Origin, e.g. non-browser tools). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

/**
 * Plain-HTTP discovery path. The extension asks "who are you?" here before opening the WebSocket:
 * Chrome throttles WebSocket connects after failed ones (anti port-scan), so scanning with
 * WebSockets would make both discovery and reconnect slow; fetch() is not throttled.
 */
export const INFO_PATH = "/info";

/** Rejects DNS-rebinding: the Host header must be a loopback name, never an attacker's domain. */
export function isLoopbackHost(host: string | undefined): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host ?? "");
}

export function createInfoHandler(info: () => unknown) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== INFO_PATH) {
      // Anything else is a plain HTTP request to a WebSocket endpoint.
      res.writeHead(426, { "content-type": "text/plain" }).end("Upgrade Required");
      return;
    }
    if (req.method !== "GET" || !isAllowedOrigin(req.headers.origin) || !isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    // No CORS headers: only the extension (which has a host permission) can read this.
    res
      .writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" })
      .end(JSON.stringify(info()));
  };
}

export type Bridge = {
  wss: WebSocketServer;
  port: number;
  /** Terminates every socket and stops listening. */
  close(): Promise<void>;
};

/** Bind exactly `port`; resolves once listening, rejects (e.g. EADDRINUSE) otherwise. */
function listen(port: number, info: () => unknown): Promise<Bridge> {
  return new Promise((resolve, reject) => {
    const http = createServer(createInfoHandler(info));
    const wss = new WebSocketServer({
      server: http,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: (v, done) => {
        if (!isLoopbackHost(v.req.headers.host)) return done(false, 403, "Forbidden host");
        if (isAllowedOrigin(v.origin)) return done(true);
        done(false, 403, "Forbidden origin");
      },
    });
    // ws re-emits the http server's errors; an unhandled 'error' event would throw.
    const swallow = () => undefined;
    wss.on("error", swallow);
    const onError = (err: Error) => {
      http.close();
      reject(err);
    };
    http.once("error", onError);
    http.listen(port, LOOPBACK, () => {
      http.removeListener("error", onError);
      wss.removeListener("error", swallow);
      resolve({
        wss,
        port: (http.address() as AddressInfo).port,
        close: async () => {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((r) => wss.close(() => r()));
          http.closeAllConnections();
          await new Promise<void>((r) => http.close(() => r()));
        },
      });
    });
  });
}

/**
 * Starts the loopback-only server the extension connects to (WebSocket + /info discovery).
 *
 * Port choice:
 *  - JOLT_PORT set (pinned): exactly that port. A previous holder is only killed when
 *    JOLT_KILL_PORT_HOLDER=1; otherwise we wait for the port to free up, then fail clearly.
 *  - Otherwise: the first free port in [port, port + portScanCount). Each MCP client (VS Code,
 *    Claude Code, ...) gets its own server and the extension finds all of them.
 *
 * Behaviour change vs upstream: binds 127.0.0.1 (not all interfaces) and rejects web-page origins.
 */
export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
  options: { waitMs?: number; scanCount?: number; info?: () => unknown } = {},
): Promise<Bridge> {
  const info = options.info ?? (() => ({}));
  const scanCount = options.scanCount ?? (mcpConfig.portPinned ? 1 : mcpConfig.portScanCount);
  if (scanCount > 1) {
    for (let i = 0; i < scanCount; i++) {
      try {
        return await listen(port + i, info);
      } catch (err) {
        // EACCES: Windows reserves some port ranges (Hyper-V/WSL); skip those like a busy port.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      }
    }
    throw new Error(
      `Ports ${port}-${port + scanCount - 1} are all in use (too many Browser MCP servers running?). Close some MCP clients or set JOLT_PORT to a free port.`,
    );
  }

  if (env("KILL_PORT_HOLDER") === "1") {
    killProcessOnPort(port);
  }
  // Binding is the only reliable "is it free?" test (a dual-stack probe misses loopback-only holders).
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  for (;;) {
    try {
      return await listen(port, info);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `Port ${port} is already in use. Close the other Jolt server, set JOLT_PORT, or set JOLT_KILL_PORT_HOLDER=1 to take the port over.`,
        );
      }
      await wait(100);
    }
  }
}
