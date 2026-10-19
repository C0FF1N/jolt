import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { type Bridge, createWebSocketServer, isAllowedOrigin, isLoopbackHost } from "@/ws";

const BASE = 19800;
const cleanup: Array<() => Promise<void>> = [];

/** Hold a port on loopback like another Browser MCP server would. */
function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
      resolve();
    });
  });
}

async function start(port: number, opts: Parameters<typeof createWebSocketServer>[1] = {}): Promise<Bridge> {
  const b = await createWebSocketServer(port, { scanCount: 3, ...opts });
  cleanup.push(() => b.close());
  return b;
}

/** Raw HTTP request so tests can set Host/Origin exactly like a browser or an attacker would. */
function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers: { connection: "close", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("createWebSocketServer: ports", () => {
  it("takes the requested port when it is free", async () => {
    const b = await start(BASE);
    expect(b.port).toBe(BASE);
  });

  it("falls through to the next free port, one server per MCP client", async () => {
    await occupy(BASE);
    const a = await start(BASE);
    const b = await start(BASE);
    expect([a.port, b.port]).toEqual([BASE + 1, BASE + 2]);
  });

  it("fails with a clear message when the whole range is taken", async () => {
    await occupy(BASE);
    await occupy(BASE + 1);
    await expect(createWebSocketServer(BASE, { scanCount: 2 })).rejects.toThrow(/all in use/i);
  });

  it("pinned (scanCount 1) never falls back and reports the busy port", async () => {
    await occupy(BASE);
    await expect(createWebSocketServer(BASE, { scanCount: 1, waitMs: 150 })).rejects.toThrow(
      /Port 19800 is already in use/,
    );
  });

  it("frees the port when closed", async () => {
    const b = await createWebSocketServer(BASE, { scanCount: 1 });
    await b.close();
    const again = await start(BASE, { scanCount: 1, waitMs: 500 });
    expect(again.port).toBe(BASE);
  });
});

describe("createWebSocketServer: /info discovery and WebSocket on one port", () => {
  const info = () => ({ name: "Jolt", client: "claude-code" });

  it("serves the server's self-description over plain HTTP", async () => {
    const b = await start(BASE, { info });
    const r = await get(b.port, "/info", { origin: "chrome-extension://abcdef" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ name: "Jolt", client: "claude-code" });
  });

  it("sends no CORS headers, so web pages cannot read it", async () => {
    const b = await start(BASE, { info });
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ host: "127.0.0.1", port: b.port, path: "/info", headers: { connection: "close" } }, resolve),
    );
    res.resume();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses web-page origins, DNS-rebinding hosts, and non-GET methods", async () => {
    const b = await start(BASE, { info });
    expect((await get(b.port, "/info", { origin: "https://evil.example" })).status).toBe(403);
    expect((await get(b.port, "/info", { host: "evil.example" })).status).toBe(403);
    expect((await get(b.port, "/info", {}, "POST")).status).toBe(403);
  });

  it("answers any other plain HTTP request like a WebSocket endpoint (426)", async () => {
    const b = await start(BASE, { info });
    expect((await get(b.port, "/")).status).toBe(426);
  });

  it("still upgrades WebSocket connections on the same port", async () => {
    const b = await start(BASE, { info });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { origin: "chrome-extension://abcdef" });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.terminate();
  });

  it("rejects WebSocket upgrades whose Host is not loopback (DNS rebinding)", async () => {
    const b = await start(BASE, { info });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { headers: { host: "evil.example" } });
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    ).rejects.toThrow(/403/);
  });

  it("serves /info with nosniff", async () => {
    const b = await start(BASE, { info });
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get({ host: "127.0.0.1", port: b.port, path: "/info", headers: { connection: "close" } }, resolve),
    );
    res.resume();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects WebSocket upgrades from web-page origins", async () => {
    const b = await start(BASE, { info });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { origin: "https://evil.example" });
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    ).rejects.toThrow(/403/);
  });
});

describe("origin and host rules", () => {
  it("allows the extension and non-browser clients, rejects web pages", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("chrome-extension://abc")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
  });

  it("accepts only loopback host names", () => {
    for (const ok of ["127.0.0.1:9470", "localhost:9470", "localhost", "[::1]:9470"]) expect(isLoopbackHost(ok)).toBe(true);
    for (const bad of ["evil.example", "127.0.0.1.evil.example:9470", "evil.example:9470", undefined]) {
      expect(isLoopbackHost(bad)).toBe(false);
    }
  });
});
