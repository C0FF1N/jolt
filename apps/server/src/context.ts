import type { WebSocket } from "ws";

import { mcpConfig } from "@repo/config/mcp.config";
import type { MessagePayload, MessageType } from "@repo/messaging/types";
import type { SocketMessageMap } from "@repo/types/messages/ws";

import { BrowserMcpError } from "@/errors";
import { ExtensionLink } from "@/transport/link";

const noConnectionMessage = `No connection to browser extension. In order to proceed, you must first connect a tab by clicking the Browser MCP extension icon in the browser toolbar and clicking the 'Connect' button.`;

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

  /** Attach a new extension socket, rejecting anything pending on the old one. */
  attach(ws: WebSocket): ExtensionLink {
    this._link?.close(
      new BrowserMcpError(
        "REPLACED",
        "Another browser tab connected and replaced this connection.",
        undefined,
        "Retry; the new tab is now the automation target.",
      ),
    );
    this._link = new ExtensionLink(ws);
    return this._link;
  }

  hasWs(): boolean {
    return !!this._link?.isOpen;
  }

  async sendSocketMessage<T extends MessageType<SocketMessageMap>>(
    type: T,
    payload: MessagePayload<SocketMessageMap, T>,
    options: { timeoutMs?: number } = {},
  ): Promise<SocketMessageMap[T]["response"]> {
    const link = this.link;
    const run = () => link.send(type, payload, options);
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
    const link = this.link;
    return link.send(type, payload, options);
  }

  async close() {
    this._link?.close(
      new BrowserMcpError("DISCONNECTED", "The MCP server is shutting down."),
    );
    this._link = undefined;
  }
}

export { mcpConfig };
