import type { WebSocket } from "ws";
import { z } from "zod";

import { BrowserMcpError } from "@/errors";
import { now, trace } from "@/utils/trace";

const ResponseFrame = z.object({
  type: z.literal("messageResponse"),
  payload: z.object({
    requestId: z.string(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
});

const HelloFrame = z.object({
  type: z.literal("hello"),
  payload: z.object({
    protocolVersion: z.number().int(),
    capabilities: z.array(z.string()).max(64),
  }),
});

export type LinkOptions = {
  maxPending?: number;
  defaultTimeoutMs?: number;
  /** Frames larger than this are dropped (protects the server's memory). */
  maxFrameBytes?: number;
  /** Called when the extension announces itself (new-protocol extensions only). */
  onHello?: () => void;
};

type Pending = {
  type: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

let idCounter = 0;
const nextId = () => `${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

/**
 * Request/response correlation over a single extension socket.
 * One persistent message listener, a bounded pending map, and every pending
 * request is rejected (never left hanging) when the socket closes or errors.
 */
export class ExtensionLink {
  private readonly pending = new Map<string, Pending>();
  private readonly maxPending: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly onHello: (() => void) | undefined;
  private closed = false;
  capabilities: ReadonlySet<string> = new Set();
  protocolVersion = 0;
  /** The extension said "bye": the user disconnected on purpose, so waiting for a reconnect is pointless. */
  saidGoodbye = false;

  constructor(
    private readonly ws: WebSocket,
    options: LinkOptions = {},
  ) {
    this.maxPending = options.maxPending ?? 64;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 64 * 1024 * 1024;
    this.onHello = options.onHello;
    ws.on("message", this.onMessage);
    ws.on("close", this.onClose);
    ws.on("error", this.onError);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  send(
    type: string,
    payload: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.isOpen) {
      return Promise.reject(
        new BrowserMcpError(
          "DISCONNECTED",
          "The browser extension connection is closed.",
          type,
          "Click the extension icon and press Connect on the tab, then retry.",
        ),
      );
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(
        new BrowserMcpError(
          "BACKPRESSURE",
          `Too many in-flight requests (${this.pending.size}).`,
          type,
          "Wait for earlier calls to finish before sending more.",
        ),
      );
    }
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        trace("ws.timeout", { type, timeoutMs });
        reject(
          new BrowserMcpError(
            "TIMEOUT",
            `No response from the extension after ${timeoutMs}ms.`,
            type,
            "The page may be busy or the tab disconnected. Retry, or take a new snapshot.",
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { type, startedAt: now(), timer, resolve, reject });
      const frame = JSON.stringify({ id, type, payload });
      trace("ws.send", { type, requestId: id, bytes: Buffer.byteLength(frame) });
      this.ws.send(frame, (err) => {
        if (err) {
          this.settle(id, (p) =>
            p.reject(new BrowserMcpError("DISCONNECTED", err.message, type)),
          );
        }
      });
    });
  }

  /** Fire-and-forget frame with no response (welcome, pong). Dropped if the socket is not open. */
  notify(type: string, payload?: unknown): void {
    if (!this.isOpen) return;
    this.ws.send(JSON.stringify({ type, payload }), () => undefined);
  }

  /** Reject everything in flight and detach listeners. Idempotent. */
  close(reason: BrowserMcpError): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.off("message", this.onMessage);
    this.ws.off("close", this.onClose);
    this.ws.off("error", this.onError);
    // A detached socket can still emit 'error' (e.g. oversized frame); without a
    // listener Node would throw and kill the whole server. Swallow and drop it.
    this.ws.on("error", () => undefined);
    this.ws.terminate();
    for (const id of [...this.pending.keys()]) {
      this.settle(id, (p) => p.reject(reason));
    }
  }

  private settle(id: string, fn: (p: Pending) => void) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  private onMessage = (data: unknown) => {
    const raw = Array.isArray(data)
      ? Buffer.concat(data as Buffer[])
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    if (raw.byteLength > this.maxFrameBytes) {
      trace("ws.drop_oversized", { bytes: raw.byteLength });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      trace("ws.drop_invalid_json");
      return;
    }
    const frame = json as { type?: unknown; t?: unknown } | null;
    if (frame?.type === "ping") {
      // Keepalive; the echo lets the extension measure round-trip time and notice a dead server.
      this.notify("pong", { t: typeof frame.t === "number" ? frame.t : undefined });
      return;
    }
    if (frame?.type === "bye") {
      this.saidGoodbye = true;
      return;
    }
    const hello = HelloFrame.safeParse(json);
    if (hello.success) {
      this.protocolVersion = hello.data.payload.protocolVersion;
      this.capabilities = new Set(hello.data.payload.capabilities);
      trace("ws.hello", { protocolVersion: this.protocolVersion });
      this.onHello?.();
      return;
    }
    const res = ResponseFrame.safeParse(json);
    if (!res.success) {
      trace("ws.drop_unknown_frame");
      return;
    }
    const { requestId, result, error } = res.data.payload;
    this.settle(requestId, (p) => {
      trace("ws.response", {
        type: p.type,
        requestId,
        durationMs: Math.round((now() - p.startedAt) * 100) / 100,
        bytes: raw.byteLength,
        error: Boolean(error),
      });
      if (error) {
        p.reject(new BrowserMcpError("EXTENSION_ERROR", error, p.type));
      } else {
        p.resolve(result);
      }
    });
  };

  private onClose = () =>
    this.close(
      new BrowserMcpError(
        "DISCONNECTED",
        "The browser extension disconnected before responding.",
        undefined,
        "Reconnect the tab from the extension popup, then retry.",
      ),
    );

  private onError = () =>
    this.close(
      new BrowserMcpError(
        "DISCONNECTED",
        "WebSocket error while waiting for the extension.",
        undefined,
        "Reconnect the tab from the extension popup, then retry.",
      ),
    );
}
