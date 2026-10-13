// Real-browser A/B benchmark: SAME extension + SAME Chromium + SAME fixtures, only the
// MCP server differs (baseline = unmodified upstream, turbo = this repo).
// Usage: node src/real-bench.mjs [--iterations=30] [--warmup=5] [--cold=5]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "./chrome.mjs";
import { startFixtureServer } from "./fixtures.mjs";
import { summarize } from "./stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v = "true"] = a.replace(/^--/, "").split("=");
  return [k, v];
}));
const iterations = Number(args.iterations ?? 30);
const warmup = Number(args.warmup ?? 5);
const coldRuns = Number(args.cold ?? 5);
const targets = [
  { name: "baseline", entry: path.join(root, "baseline/dist/index.js"), port: 19611 },
  { name: "turbo", entry: path.join(root, "apps/server/dist/index.js"), port: 19612 },
];

const txt = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const bytesOf = (r) =>
  (r.content ?? []).reduce((n, c) => n + Buffer.byteLength(c.text ?? c.data ?? ""), 0);
const refOf = (s, re) => s.match(re)?.[1];

const fixtures = await startFixtureServer();
const chrome = await launchChrome({ extensionDir: path.join(root, "apps/extension/dist") });
await chrome.openPage(`${fixtures.origin}/login`);
const tabId = await chrome.tabIdFor(fixtures.origin);

async function withServer(t, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [t.entry],
    env: { ...process.env, BROWSERMCP_PORT: String(t.port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(transport);
  await new Promise((r) => setTimeout(r, 250));
  const call = (name, a = {}) => client.callTool({ name, arguments: a }, undefined, { timeout: 60000 });
  try {
    const t0 = performance.now();
    const status = await chrome.connectTab(tabId, t.port);
    if (status.state !== "connected") throw new Error(`connect failed: ${JSON.stringify(status)}`);
    const connectMs = performance.now() - t0;
    return await fn({ call, connectMs });
  } finally {
    await chrome.disconnect().catch(() => {});
    await client.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function loginRefs(call) {
  await call("browser_navigate", { url: `${fixtures.origin}/login` });
  const s = txt(await call("browser_snapshot"));
  return {
    email: refOf(s, /textbox "Email"[^\n]*\[ref=(e\d+)\]/),
    btn: refOf(s, /button "Submit"[^\n]*\[ref=(e\d+)\]/),
  };
}

const results = { iterations, warmup, coldRuns, targets: {} };
for (const t of targets) {
  const out = { cold: null, scenarios: {} };
  const isTurbo = t.name === "turbo";

  const cold = { connect_ms: [], first_snapshot_ms: [] };
  for (let i = 0; i < coldRuns; i++) {
    await withServer(t, async ({ call, connectMs }) => {
      const t0 = performance.now();
      await call("browser_snapshot");
      cold.first_snapshot_ms.push(performance.now() - t0);
      cold.connect_ms.push(connectMs);
    });
  }
  out.cold = { connect_ms: summarize(cold.connect_ms), first_snapshot_ms: summarize(cold.first_snapshot_ms) };

  await withServer(t, async ({ call }) => {
    const quiet = isTurbo ? { snapshot: "none" } : {}; // untimed setup navigation
    const toolName = (a) => `browser_${a}`;
    const el = (ref, name) => ({ element: name, ref });
    const tenActions = (r) => [
      ["type", { ...el(r.email, "Email"), text: "a@b.c", submit: false }],
      ["click", el(r.btn, "Submit")],
      ["type", { ...el(r.email, "Email"), text: "d@e.f", submit: false }],
      ["click", el(r.btn, "Submit")],
      ["hover", el(r.btn, "Submit")],
      ["click", el(r.btn, "Submit")],
      ["type", { ...el(r.email, "Email"), text: "g@h.i", submit: false }],
      ["click", el(r.btn, "Submit")],
      ["hover", el(r.btn, "Submit")],
      ["click", el(r.btn, "Submit")],
    ];
    const defs = [
      { name: "status", page: "/login", run: async () => [await call("browser_get_console_logs")] },
      { name: "snapshot_small", page: "/login", run: async () => [await call("browser_snapshot")] },
      { name: "snapshot_large", page: "/large", run: async () => [await call("browser_snapshot")] },
      { name: "click", page: "/login", run: async (r) => [await call("browser_click", el(r.btn, "Submit"))] },
      { name: "type", page: "/login", run: async (r) => [await call("browser_type", { ...el(r.email, "Email"), text: "x@y.z", submit: false })] },
      { name: "navigate", page: "/login", run: async () => [await call("browser_navigate", { url: `${fixtures.origin}/login` })] },
      {
        name: "sequence_10_standard_tools",
        page: "/login",
        run: async (r) => {
          const rs = [];
          for (const [a, p] of tenActions(r)) rs.push(await call(toolName(a), p));
          return rs;
        },
      },
    ];
    if (isTurbo) {
      defs.push(
        { name: "click_snapshot_none", page: "/login", run: async (r) => [await call("browser_click", { ...el(r.btn, "Submit"), snapshot: "none" })] },
        {
          name: "sequence_10_snapshot_none",
          page: "/login",
          run: async (r) => {
            const rs = [];
            for (const [a, p] of tenActions(r)) rs.push(await call(toolName(a), { ...p, snapshot: "none" }));
            rs.push(await call("browser_snapshot"));
            return rs;
          },
        },
        {
          name: "batch_10",
          page: "/login",
          run: async (r) => [
            await call("browser_batch", {
              finalSnapshot: "summary",
              actions: tenActions(r).map(([a, p]) => ({ action: a, ...p })),
            }),
          ],
        },
      );
    }

    for (const def of defs) {
      // Untimed setup: load the scenario's page and read fresh refs.
      await call("browser_navigate", { url: `${fixtures.origin}${def.page}`, ...quiet });
      const snap = txt(await call("browser_snapshot"));
      const refs = {
        email: refOf(snap, /textbox "Email"[^\n]*\[ref=(e\d+)\]/),
        btn: refOf(snap, /button "Submit"[^\n]*\[ref=(e\d+)\]/),
      };
      for (let i = 0; i < warmup; i++) await def.run(refs);
      const lat = [];
      const bytes = [];
      let failures = 0;
      let calls = 0;
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) {
        const st = performance.now();
        try {
          const rs = await def.run(refs);
          calls += rs.length;
          failures += rs.filter((r) => r.isError).length;
          bytes.push(rs.reduce((n, r) => n + bytesOf(r), 0));
        } catch {
          failures++;
        }
        lat.push(performance.now() - st);
      }
      const wall = (performance.now() - t0) / 1000;
      const sc = {
        tool_calls_per_iter: calls / iterations,
        latency_ms: summarize(lat),
        response_bytes: summarize(bytes),
        iterations_per_sec: iterations / wall,
        failure_rate: failures / Math.max(1, calls),
      };
      out.scenarios[def.name] = sc;
      console.error(
        `${t.name.padEnd(8)} ${def.name.padEnd(28)} median ${sc.latency_ms.median.toFixed(1)}ms p95 ${sc.latency_ms.p95.toFixed(1)}ms  bytes ${sc.response_bytes?.median ?? 0}  calls/iter ${sc.tool_calls_per_iter}  failures ${(sc.failure_rate * 100).toFixed(0)}%`,
      );
    }
  });
  results.targets[t.name] = out;
}

results.env = {
  chromium: chrome.version,
  node: process.version,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  totalMemGb: Math.round(os.totalmem() / 2 ** 30),
  date: new Date().toISOString(),
  notes:
    "Real headless Chromium + new extension + local loopback fixtures. Same extension for both servers; only the MCP server differs. Single machine, single run set; not isolated from other processes.",
};
mkdirSync(path.join(here, "../results"), { recursive: true });
const file = path.join(here, "../results", `real-chrome-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.error("wrote", file);
await chrome.close();
await fixtures.close();
