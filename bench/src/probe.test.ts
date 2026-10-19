import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { isListening, probePort, scanPorts } from "../../apps/extension/src/probe";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const info = (port: number) => ({
  name: "Jolt",
  version: "1",
  protocolVersion: 2,
  pid: 1,
  port,
  startedAt: 10,
  client: "claude-code",
  connected: false,
});

/** A server that answers GET /info like ours; records every path it was asked for. */
function fakeServer(port: number, handler?: http.RequestListener) {
  const paths: string[] = [];
  const srv = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    if (handler) return handler(req, res);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info(port)));
  });
  cleanup.push(
    () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
  );
  return { paths, ready: new Promise<void>((r) => srv.listen(port, "127.0.0.1", r)) };
}

describe("probePort / scanPorts", () => {
  it("reads the server's self-description over HTTP /info", async () => {
    const s = fakeServer(19900);
    await s.ready;
    expect(await probePort(19900)).toMatchObject({ port: 19900, client: "claude-code" });
    expect(s.paths).toEqual(["/info"]); // a plain GET: never touches a WebSocket
  });

  it("returns null for a closed port, quickly", async () => {
    const t = Date.now();
    expect(await probePort(19999, 800)).toBeNull();
    expect(Date.now() - t).toBeLessThan(700);
  });

  it("ignores a service that is not ours (wrong shape, error status, not JSON)", async () => {
    const a = fakeServer(19901, (_q, res) => res.writeHead(200).end(JSON.stringify({ hello: "stranger" })));
    const b = fakeServer(19902, (_q, res) => res.writeHead(426).end("Upgrade Required"));
    const c = fakeServer(19903, (_q, res) => res.writeHead(200).end("<html>"));
    await Promise.all([a.ready, b.ready, c.ready]);
    expect(await probePort(19901)).toBeNull();
    expect(await probePort(19902)).toBeNull();
    expect(await probePort(19903)).toBeNull();
  });

  it("gives up on a TCP service that never answers", async () => {
    const held = new Set<net.Socket>();
    const sink = net.createServer((s) => held.add(s)); // accepts, says nothing
    await new Promise<void>((r) => sink.listen(19904, "127.0.0.1", r));
    cleanup.push(() => {
      for (const s of held) s.destroy();
      return new Promise<void>((r) => sink.close(() => r()));
    });
    const t = Date.now();
    expect(await probePort(19904, 200)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("isListening: true for any HTTP answer (even 426 from a WebSocket-only server), false when refused", async () => {
    const s = fakeServer(19908, (_q, res) => res.writeHead(426).end("Upgrade Required"));
    await s.ready;
    expect(await isListening(19908)).toBe(true);
    expect(await isListening(19998, 800)).toBe(false);
  });

  it("scans several ports and returns only the live servers", async () => {
    const a = fakeServer(19905);
    const b = fakeServer(19907);
    await Promise.all([a.ready, b.ready]);
    const found = await scanPorts([19905, 19906, 19907], 500);
    expect(found.map((f) => f.port)).toEqual([19905, 19907]);
  });
});
