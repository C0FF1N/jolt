import type { WebSocket } from "ws";

import { env } from "@repo/config/env";
import { mcpConfig } from "@repo/config/mcp.config";
import type { MessagePayload, MessageType } from "@repo/messaging/types";
import type { SocketMessageMap } from "@repo/types/messages/ws";

import { BrowserMcpError } from "@/errors";
import { ExtensionLink } from "@/transport/link";

const noConnectionMessage = `No browser tab is connected. Open the Jolt extension on the tab you want to automate and press Connect (it finds this server by itself).`;

/**
 * How long a tool call waits for the extension to (re)connect before failing with NO_CONNECTION.
 * Covers the extension's reconnect after a service-worker restart or a quick server bounce, so the
 * agent never sees a transient drop. Skipped when the user disconnected on purpose.
 */
const CONNECT_GRACE_MS = (() => {
  const v = Number(env("CONNECT_GRACE_MS"));
  return Number.isFinite(v) && v >= 0 ? v : 4000;
})();

/** Message types that only read page state and may overlap with each other. */
const READ_ONLY = new Set<string>([
  "getUrl",
  "getTitle",
  "browser_snapshot",
  "browser_snapshot_bundle",
  "browser_screenshot",
  "browser_get_console_logs",
]);

export class Context {
  private _link: ExtensionLink | undefined;
  private attachWaiters = new Set<() => void>();
  /** Tail of the queue of state-changing operations (one tab => one at a time). */
  private writeTail: Promise<unknown> = Promise.resolve();

  /** @deprecated kept for source compatibility; prefer `link`. */
  get ws(): never {
    throw new Error("Use context.link instead of context.ws");
  }

  get link(): ExtensionLink {
    if (!this._link || !this._link.isOpen) {
      throw new BrowserMcpError(
        "NO_CONNECTION",
        noConnectionMessage,
        undefined,
        "Open the extension popup on the target tab and click Connect.",
      );
    }
    return this._link;
  }

  /** Like `link`, but first gives a dropped extension a moment to reconnect. */
  async requireLink(graceMs: number = CONNECT_GRACE_MS): Promise<ExtensionLink> {
    if (this._link?.isOpen) return this._link;
    if (graceMs > 0 && !this._link?.saidGoodbye) await this.waitForAttach(graceMs);
    return this.link;
  }

  private waitForAttach(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.attachWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.attachWaiters.add(done);
    });
  }

  /** Attach a new extension socket, rejecting anything pending on the old one. */
  attach(ws: WebSocket, options: { onHello?: () => void } = {}): ExtensionLink {
    this._link?.close(
      new BrowserMcpError(
        "REPLACED",
        "Another browser tab connected and replaced this connection.",
        undefined,
        "Retry; the new tab is now the automation target.",
      ),
    );
    this._link = new ExtensionLink(ws, { onHello: options.onHello });
    for (const wake of [...this.attachWaiters]) wake();
    return this._link;
  }

  hasWs(): boolean {
    return !!this._link?.isOpen;
  }

  /** Push an informational frame to the connected extension (no-op when none). */
  notifyExtension(type: string, payload?: unknown): void {
    if (this._link?.isOpen) this._link.notify(type, payload);
  }

  async sendSocketMessage<T extends MessageType<SocketMessageMap>>(
    type: T,
    payload: MessagePayload<SocketMessageMap, T>,
    options: { timeoutMs?: number } = {},
  ): Promise<SocketMessageMap[T]["response"]> {
    // Resolve the link when the call actually runs, not when it is queued: a write that waited its
    // turn across a reconnect must use the new link, not the dead one it saw at enqueue time.
    const run = async () => (await this.requireLink()).send(type, payload, options);
    if (READ_ONLY.has(type)) {
      return (await run()) as SocketMessageMap[T]["response"];
    }
    // Serialize interactions so two actions can never race on the same tab.
    const result = this.writeTail.then(run, run);
    this.writeTail = result.catch(() => undefined);
    return (await result) as SocketMessageMap[T]["response"];
  }

  /** Send a type outside the legacy SocketMessageMap (new capabilities). */
  async sendCustom(
    type: string,
    payload: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const link = await this.requireLink();
    return link.send(type, payload, options);
  }

  async close() {
    for (const wake of [...this.attachWaiters]) wake();
    this._link?.close(
      new BrowserMcpError("DISCONNECTED", "The MCP server is shutting down."),
    );
    this._link = undefined;
  }
}

export { mcpConfig };
