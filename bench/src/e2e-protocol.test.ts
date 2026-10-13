// End-to-end over the real wire: built turbo server (MCP stdio) <-> WebSocket <->
// the REAL extension handlers driving a stateful fake page (no Chrome needed).
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    const respond = (body: object) =>
      ws.readyState === ws.OPEN &&
      ws.send(JSON.stringify({ type: "messageResponse", payload: { requestId: msg.id, ...body } }));
    try {
      respond({ result: await handlers[msg.type](msg.payload ?? {}) });
    } catch (e) {
      respond({ error: (e as Error).message });
    }
  });
  return { ws, page, opened };
}

let client: Client;
let port: number;
let portSeq = 19400;

async function startServer() {
  port = portSeq++;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, BROWSERMCP_PORT: String(port) } as Record<string, string>,
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
  beforeEach(startServer);
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
});
