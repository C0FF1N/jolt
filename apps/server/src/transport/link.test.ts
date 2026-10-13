import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BrowserMcpError } from "@/errors";
import { ExtensionLink } from "@/transport/link";

let wss: WebSocketServer;
let port: number;
let serverSide: WebSocket;
let clientSide: WebSocket; // plays the extension
let link: ExtensionLink;
let baseline = { message: 0, close: 0, error: 0 };

async function connect(): Promise<void> {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  port = (wss.address() as { port: number }).port;
  const accepted = new Promise<WebSocket>((r) =>
    wss.once("connection", (ws) => r(ws)),
  );
  clientSide = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((r) => clientSide.once("open", () => r()));
  serverSide = await accepted;
}

/** Make the fake extension answer every request via `reply`. */
function answer(
  reply: (msg: { id: string; type: string; payload: unknown }) => unknown,
) {
  clientSide.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const out = reply(msg);
    if (out === undefined) return;
    clientSide.send(
      JSON.stringify({
        type: "messageResponse",
        payload: { requestId: msg.id, ...(out as object) },
      }),
    );
  });
}

beforeEach(async () => {
  await connect();
  baseline = {
    message: serverSide.listenerCount("message"),
    close: serverSide.listenerCount("close"),
    error: serverSide.listenerCount("error"),
  };
  link = new ExtensionLink(serverSide, { maxPending: 3, defaultTimeoutMs: 500 });
});

afterEach(async () => {
  link.close(new BrowserMcpError("DISCONNECTED", "test cleanup"));
  clientSide.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

describe("ExtensionLink", () => {
  it("correlates concurrent responses that arrive out of order", async () => {
    answer((m) =>
      m.type === "slow"
        ? undefined // answered manually below
        : { result: `r:${m.type}` },
    );
    const slow = link.send("slow", {});
    const fast = link.send("fast", {});
    await expect(fast).resolves.toBe("r:fast");
    // answer the slow one afterwards
    clientSide.on("message", () => {});
    expect(link.pendingCount).toBe(1);
    const slowId = [...(link as any).pending.keys()][0];
    clientSide.send(
      JSON.stringify({
        type: "messageResponse",
        payload: { requestId: slowId, result: "r:slow" },
      }),
    );
    await expect(slow).resolves.toBe("r:slow");
    expect(link.pendingCount).toBe(0);
  });

  it("rejects with an extension error and clears the timer", async () => {
    answer(() => ({ error: "Element not found" }));
    await expect(link.send("browser_click", {})).rejects.toMatchObject({
      code: "EXTENSION_ERROR",
      operation: "browser_click",
    });
    expect(link.pendingCount).toBe(0);
  });

  it("times out with an actionable error naming the operation", async () => {
    const p = link.send("browser_snapshot", {}, { timeoutMs: 50 });
    await expect(p).rejects.toMatchObject({
      code: "TIMEOUT",
      operation: "browser_snapshot",
    });
    expect(((await p.catch((e) => e)) as BrowserMcpError).hint).toMatch(/retry/i);
    expect(link.pendingCount).toBe(0);
  });

  it("rejects every pending request when the socket closes (no hangs)", async () => {
    const a = link.send("a", {});
    const b = link.send("b", {});
    clientSide.close();
    await expect(a).rejects.toMatchObject({ code: "DISCONNECTED" });
    await expect(b).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(link.pendingCount).toBe(0);
  });

  it("applies backpressure beyond maxPending", async () => {
    const held = [link.send("a", {}), link.send("b", {}), link.send("c", {})];
    await expect(link.send("d", {})).rejects.toMatchObject({
      code: "BACKPRESSURE",
    });
    link.close(new BrowserMcpError("DISCONNECTED", "done"));
    await Promise.allSettled(held);
  });

  it("registers exactly one message listener regardless of request count", async () => {
    const before = serverSide.listenerCount("message");
    expect(before).toBe(baseline.message + 1);
    answer((m) => ({ result: m.type }));
    await Promise.all(
      Array.from({ length: 3 }, (_, i) => link.send(`t${i}`, {})),
    );
    expect(serverSide.listenerCount("message")).toBe(before);
  });

  it("removes its listeners on close", () => {
    link.close(new BrowserMcpError("REPLACED", "replaced"));
    expect(serverSide.listenerCount("message")).toBe(baseline.message);
    expect(serverSide.listenerCount("close")).toBe(baseline.close);
    // One no-op error listener stays on purpose: a detached socket may still emit 'error'
    // (e.g. oversized frame) and an unhandled one would crash the process. The socket is terminated.
    expect(serverSide.listenerCount("error")).toBe(baseline.error + 1);
    expect(serverSide.readyState).toBeGreaterThanOrEqual(serverSide.CLOSING);
  });

  it("ignores malformed frames and unknown request ids", async () => {
    answer((m) => ({ result: m.type }));
    clientSide.send("not json");
    clientSide.send(
      JSON.stringify({ type: "messageResponse", payload: { requestId: "nope" } }),
    );
    clientSide.send(JSON.stringify({ type: "messageResponse", payload: 5 }));
    await expect(link.send("ok", {})).resolves.toBe("ok");
  });

  it("records capabilities from a hello frame", async () => {
    clientSide.send(
      JSON.stringify({
        type: "hello",
        payload: { protocolVersion: 2, capabilities: ["snapshotBundle"] },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(link.has("snapshotBundle")).toBe(true);
    expect(link.has("other")).toBe(false);
    expect(link.protocolVersion).toBe(2);
  });

  it("fails fast when the socket is already closed", async () => {
    clientSide.close();
    await new Promise((r) => setTimeout(r, 50));
    await expect(link.send("x", {})).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
  });
});
