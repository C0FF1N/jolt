// End-to-end over the real wire: built Jolt server (MCP stdio) <-> WebSocket <->
// the REAL extension handlers driving a stateful fake page (no Chrome needed).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AXNode } from "../../apps/extension/src/aria";
import { CAPABILITIES, type Cdp, createHandlers } from "../../apps/extension/src/handlers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const entry = path.join(root, "apps/server/dist/index.js");
const built = existsSync(entry);
const v = (value: unknown) => ({ type: "x", value });

/** A tiny login page: textbox + button; clicking the button shows a welcome message. */
function fakePage() {
  const page = { email: "", submitted: false, url: "http://fixture/login" };
  const cdp: Cdp = {
    async send(method, params) {
      switch (method) {
        case "Accessibility.getFullAXTree": {
          const nodes: AXNode[] = [
            { nodeId: "1", role: v("RootWebArea"), name: v("Login"), childIds: ["2", "3", "4"] } as AXNode,
            { nodeId: "2", parentId: "1", role: v("textbox"), name: v("Email"), value: v(page.email), backendDOMNodeId: 11 } as AXNode,
            { nodeId: "3", parentId: "1", role: v("button"), name: v("Submit"), backendDOMNodeId: 12 } as AXNode,
          ];
          if (page.submitted) {
            nodes.push({ nodeId: "4", parentId: "1", role: v("StaticText"), name: v(`Welcome ${page.email}`) } as AXNode);
          } else {
            (nodes[0] as any).childIds = ["2", "3"];
          }
          return { nodes } as any;
        }
        case "DOM.resolveNode":
          return { object: { objectId: `o${(params as any).backendNodeId}` } } as any;
        case "DOM.getBoxModel":
          return {
            model: {
              content:
                (params as any).backendNodeId === 12
                  ? [100, 100, 120, 100, 120, 120, 100, 120]
                  : [0, 0, 20, 0, 20, 20, 0, 20],
            },
          } as any;
        case "Input.insertText":
          page.email = (params as any).text;
          return {} as any;
        case "Input.dispatchMouseEvent":
          if ((params as any).type === "mouseReleased" && (params as any).x === 110) page.submitted = true;
          return {} as any;
        case "Page.navigate":
          page.url = (params as any).url;
          return {} as any;
        case "Runtime.evaluate":
          // wait_for: succeed only once the page shows the welcome text
          return page.submitted ? ({} as any) : ({ exceptionDetails: { text: "timed out" } } as any);
        default:
          return {} as any;
      }
    },
    once: async () => ({}),
    tab: async () => ({ url: page.url, title: "Login" }),
  };
  return { page, cdp };
}

function connectExtension(
  port: number,
  { caps = [...CAPABILITIES] as string[], origin }: { caps?: string[]; origin?: string } = {},
) {
  const { page, cdp } = fakePage();
  const handlers = createHandlers({ cdp, consoleLog: () => [] });
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      if (caps.length) {
        ws.send(JSON.stringify({ type: "hello", payload: { protocolVersion: 2, capabilities: caps } }));
      }
      resolve();
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const frames: { type: string; payload?: any }[] = []; // server -> extension notifications (no id)
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id !== "string") {
      frames.push(msg);
      return;
    }
    const respond = (body: object) =>
      ws.readyState === ws.OPEN &&
      ws.send(JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, ...body } }));
    try {
      respond({ result: await handlers[msg.type](msg.payload ?? {}) });
    } catch (e) {
      respond({ error: (e as Error).message });
    }
  });
  return { ws, page, opened, frames };
}

let client: Client;
let port: number;
let portSeq = 19400;

/** `grace` = JOLT_CONNECT_GRACE_MS; 0 keeps the "no tab connected" tests instant. */
async function startServer(grace = "0", extraEnv: Record<string, string> = {}) {
  port = portSeq++;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      JOLT_PORT: String(port),
      JOLT_CONNECT_GRACE_MS: grace,
      ...extraEnv,
    } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  await new Promise((r) => setTimeout(r, 200)); // let the WS server bind
}

const call = (name: string, args: object = {}) =>
  client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

describe.skipIf(!built)("server <-> extension protocol (fake page)", () => {
  beforeEach(() => startServer());
  afterEach(async () => {
    await client.close().catch(() => {});
  });

  it("fails fast with an actionable error when no tab is connected", async () => {
    const r = await call("browser_snapshot");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/NO_CONNECTION/);
    expect(text(r)).toMatch(/Connect/);
  });

  it("runs snapshot -> type -> click and sees the page change (bundle path)", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    let r = await call("browser_snapshot");
    expect(text(r)).toContain('textbox "Email"');
    expect(text(r)).toContain("Page URL: http://fixture/login");
    r = await call("browser_type", { element: "Email", ref: "e1", text: "a@b.c", submit: false });
    expect(text(r)).toContain('Typed "a@b.c"');
    r = await call("browser_click", { element: "Submit", ref: "e2" });
    expect(text(r)).toContain("Welcome a@b.c");
    ext.ws.close();
  });

  it("works with a legacy extension that sends no hello (concurrent-read fallback)", async () => {
    const ext = connectExtension(port, { caps: [] });
    await ext.opened;
    // legacy extension does not know the bundle message, but the server must not send it
    const r = await call("browser_snapshot");
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Page Title: Login");
    ext.ws.close();
  });

  it("skips the post-action snapshot with snapshot=none", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    await call("browser_snapshot");
    const r = await call("browser_click", { element: "Submit", ref: "e2", snapshot: "none" });
    expect(text(r)).toBe('Clicked "Submit"');
    ext.ws.close();
  });

  it("batch: fill form, submit, wait for text, in one call", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    await call("browser_snapshot");
    const r = await call("browser_batch", {
      actions: [
        { action: "type", element: "Email", ref: "e1", text: "x@y.z" },
        { action: "click", element: "Submit", ref: "e2" },
        { action: "wait_for", text: "Welcome", timeoutMs: 1000 },
      ],
    });
    const outcome = JSON.parse((r.content as any)[0].text);
    expect(outcome).toMatchObject({ ok: true, completed: 3, failed: 0, skipped: 0 });
    expect(ext.page.submitted).toBe(true);
    ext.ws.close();
  });

  it("batch: a failing action stops the batch and skips the rest", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    await call("browser_snapshot");
    const r = await call("browser_batch", {
      actions: [
        { action: "click", element: "Ghost", ref: "e99" },
        { action: "click", element: "Submit", ref: "e2" },
      ],
    });
    expect(r.isError).toBe(true);
    const outcome = JSON.parse((r.content as any)[0].text);
    expect(outcome.results.map((x: any) => x.status)).toEqual(["failed", "skipped"]);
    expect(outcome.results[0].error.message).toMatch(/new snapshot/i);
    expect(ext.page.submitted).toBe(false);
    ext.ws.close();
  });

  it("wait_for returns an actionable timeout naming the condition", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    const r = await call("browser_wait_for", { text: "Never appears", timeoutMs: 300 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/TIMEOUT.*Never appears/s);
    ext.ws.close();
  });

  it("wait_for is UNSUPPORTED for an extension without the capability", async () => {
    const ext = connectExtension(port, { caps: [] });
    await ext.opened;
    const r = await call("browser_wait_for", { text: "x" });
    expect(text(r)).toMatch(/UNSUPPORTED/);
    ext.ws.close();
  });

  it("a mid-call disconnect rejects promptly instead of hanging", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    // make the extension swallow requests, then drop the socket
    ext.ws.removeAllListeners("message");
    const pending = call("browser_snapshot");
    setTimeout(() => ext.ws.close(), 100);
    const started = Date.now();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/DISCONNECTED/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("recovers after the extension reconnects", async () => {
    const first = connectExtension(port);
    await first.opened;
    first.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const second = connectExtension(port);
    await second.opened;
    const r = await call("browser_snapshot");
    expect(r.isError).toBeFalsy();
    second.ws.close();
  });

  it("a new connection replaces the old one and rejects its pending work", async () => {
    const first = connectExtension(port);
    await first.opened;
    first.ws.removeAllListeners("message"); // never answers
    const pending = call("browser_snapshot");
    await new Promise((r) => setTimeout(r, 100));
    const second = connectExtension(port);
    await second.opened;
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/REPLACED|DISCONNECTED/);
    second.ws.close();
  });

  it("rejects web-page origins and accepts extension origins", async () => {
    await expect(connectExtension(port, { origin: "https://evil.example" }).opened).rejects.toThrow(/403/);
    const ok = connectExtension(port, { origin: "chrome-extension://abcdefghijklmnop" });
    await ok.opened;
    ok.ws.close();
  });

  it("listens on loopback only", async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return; // no external interface to test against
    const probe = new WebSocket(`ws://${lan.address}:${port}`);
    await expect(
      new Promise((resolve, reject) => {
        probe.once("open", () => resolve("open"));
        probe.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("survives a replaced socket sending garbage (no unhandled error crash)", async () => {
    const first = connectExtension(port);
    await first.opened;
    const second = connectExtension(port);
    await second.opened;
    // The server terminates the replaced socket; sending on it must not take the server down.
    try { first.ws.send("x".repeat(1000)); } catch { /* socket may already be closed */ }
    await new Promise((r) => setTimeout(r, 300));
    const r = await call("browser_snapshot");
    expect(r.isError).toBeFalsy();
    second.ws.close();
  });

  it("closes the replaced socket", async () => {
    const first = connectExtension(port);
    await first.opened;
    const closed = new Promise<void>((resolve) => first.ws.once("close", () => resolve()));
    const second = connectExtension(port);
    await second.opened;
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("old socket still open")), 3000))]);
    second.ws.close();
  });

  it("tolerates keepalive ping frames from the extension", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    ext.ws.send(JSON.stringify({ type: "ping" }));
    const r = await call("browser_snapshot");
    expect(r.isError).toBeFalsy();
    ext.ws.close();
  });

  it("answers a keepalive ping with a pong that echoes the timestamp", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    ext.ws.send(JSON.stringify({ type: "ping", t: 1234 }));
    await vi.waitFor(() => expect(ext.frames.find((f) => f.type === "pong")?.payload).toEqual({ t: 1234 }));
    ext.ws.close();
  });

  it("welcomes a new-protocol extension with the MCP client's name, but a legacy one gets nothing", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    await vi.waitFor(() => expect(ext.frames.some((f) => f.type === "welcome")).toBe(true));
    expect(ext.frames.find((f) => f.type === "welcome")!.payload).toMatchObject({
      name: "Jolt",
      client: "e2e",
      port,
      protocolVersion: 2,
    });
    const legacy = connectExtension(port, { caps: [] });
    await legacy.opened;
    await new Promise((r) => setTimeout(r, 300));
    expect(legacy.frames).toEqual([]);
    legacy.ws.close();
  });

  it("answers GET /info with server info WITHOUT touching the live extension link", async () => {
    const ext = connectExtension(port);
    await ext.opened;
    const res = await fetch(`http://127.0.0.1:${port}/info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "Jolt",
      client: "e2e",
      port,
      connected: true,
      protocolVersion: 2,
    });
    const r = await call("browser_snapshot");
    expect(r.isError).toBeFalsy(); // the original connection is still the live one
    ext.ws.close();
  });

  it("reports connected:false until an extension links up", async () => {
    const before = await (await fetch(`http://127.0.0.1:${port}/info`)).json();
    expect(before.connected).toBe(false);
  });
});

describe.skipIf(!built)("connection grace", () => {
  afterEach(async () => {
    await client.close().catch(() => {});
  });

  it("waits for a reconnecting extension instead of failing the call", async () => {
    await startServer("3000");
    const pending = call("browser_snapshot");
    await new Promise((r) => setTimeout(r, 500));
    const ext = connectExtension(port);
    await ext.opened;
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('textbox "Email"');
    ext.ws.close();
  });

  it("still gives up with NO_CONNECTION after the grace period", async () => {
    await startServer("400");
    const started = Date.now();
    const r = await call("browser_snapshot");
    expect(text(r)).toMatch(/NO_CONNECTION/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it("does not wait when the extension disconnected on purpose (bye)", async () => {
    await startServer("5000");
    const ext = connectExtension(port);
    await ext.opened;
    ext.ws.send(JSON.stringify({ type: "bye" }));
    ext.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    const r = await call("browser_snapshot");
    expect(text(r)).toMatch(/NO_CONNECTION/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe.skipIf(!built)("automatic port selection", () => {
  it("two servers started without JOLT_PORT land on different ports and both answer a probe", async () => {
    const base = 19600;
    // Unpinned: scan from `base`. JOLT_PORT must be absent, so build a clean env.
    const env = { ...process.env } as Record<string, string>;
    delete env.JOLT_PORT;
    const mk = () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env: { ...env, JOLT_BASE_PORT: String(base) },
        stderr: "pipe",
      });
      const c = new Client({ name: "multi", version: "0" });
      return { c, transport, connect: () => c.connect(transport) };
    };
    const a = mk();
    const b = mk();
    await a.connect();
    await b.connect();
    await new Promise((r) => setTimeout(r, 300));
    const ports: number[] = [];
    for (const p of [base, base + 1, base + 2]) {
      try {
        const info = await (await fetch(`http://127.0.0.1:${p}/info`, { signal: AbortSignal.timeout(800) })).json();
        ports.push(info.port);
      } catch {
        /* nothing listening on this port */
      }
    }
    expect(ports).toEqual([base, base + 1]);
    await a.c.close().catch(() => {});
    await b.c.close().catch(() => {});
  });
});

describe.skipIf(!built)("shutdown", () => {
  it("exits promptly when the MCP client closes while an extension is connected", async () => {
    await startServer();
    const ext = connectExtension(port);
    await ext.opened;
    const started = Date.now();
    await client.close();
    expect(Date.now() - started).toBeLessThan(5000);
    ext.ws.close();
  });
});
