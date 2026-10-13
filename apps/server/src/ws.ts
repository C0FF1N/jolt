import { WebSocketServer } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import { wait } from "@repo/utils";

import { isPortInUse, killProcessOnPort } from "@/utils/port";

const LOOPBACK = "127.0.0.1";

/** Origins that may open the socket: the extension itself (or no Origin, e.g. non-browser tools). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

/**
 * Starts the loopback-only WebSocket server the extension connects to.
 *
 * Behaviour change vs upstream: binds 127.0.0.1 (not all interfaces) and
 * rejects web-page origins. A previous holder of the port is only killed
 * when BROWSERMCP_KILL_PORT_HOLDER=1 (upstream always killed it); otherwise
 * we wait for the port to free up, then fail with a clear message.
 */
export async function createWebSocketServer(
  port: number = mcpConfig.defaultWsPort,
  options: { waitMs?: number } = {},
): Promise<WebSocketServer> {
  if (process.env.BROWSERMCP_KILL_PORT_HOLDER === "1") {
    killProcessOnPort(port);
  }
  const deadline = Date.now() + (options.waitMs ?? 10_000);
  while (await isPortInUse(port)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Port ${port} is already in use. Close the other Browser MCP server, set BROWSERMCP_PORT, or set BROWSERMCP_KILL_PORT_HOLDER=1 to take the port over.`,
      );
    }
    await wait(100);
  }
  return new WebSocketServer({
    port,
    host: LOOPBACK,
    maxPayload: 64 * 1024 * 1024,
    verifyClient: (info, done) => {
      if (isAllowedOrigin(info.origin)) return done(true);
      done(false, 403, "Forbidden origin");
    },
  });
}
