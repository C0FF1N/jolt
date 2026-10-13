// Benchmark runner: drives a built server (baseline|turbo) over MCP stdio with
// a mock extension on a private loopback port. Writes raw JSON to bench/results.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMockExtension } from "./mock-extension.mjs";
import { summarize } from "./stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const target = args.target ?? "baseline"; // baseline | turbo
const iterations = Number(args.iterations ?? 30);
const warmup = Number(args.warmup ?? 5);
const coldRuns = Number(args.cold ?? 5);
const rttMs = Number(args.rtt ?? 1);
const port = Number(args.port ?? (target === "baseline" ? 19109 : 19209));
const entry = path.join(root, target === "baseline" ? "baseline" : "apps/server", "dist/index.js");

const caps = (args.caps ?? "").split(",").filter(Boolean); // e.g. snapshotBundle
const label = args.label ?? (caps.length ? "bundle" : "legacy");
const SMALL = 50;
const LARGE = 5000;

const el = { element: "Item 1", ref: "e1" };
const scenarios = {
  status: [["browser_get_console_logs", {}]],
  snapshot_small: [["browser_snapshot", {}], { nodes: SMALL }],
  snapshot_large: [["browser_snapshot", {}], { nodes: LARGE }],
  element_lookup_hover: [["browser_hover", el]],
  click: [["browser_click", el]],
  type: [["browser_type", { ...el, text: "hello", submit: false }]],
  navigate: [["browser_navigate", { url: "http://127.0.0.1/x" }]],
  ...(target === "turbo"
    ? {
        click_snapshot_none: [["browser_click", { ...el, snapshot: "none" }]],
        batch_10: [["browser_batch", { finalSnapshot: "summary", actions: [
          { action: "navigate", url: "http://127.0.0.1/x" },
          { action: "click", ...el }, { action: "type", ...el, text: "a" },
          { action: "click", ...el }, { action: "type", ...el, text: "b" },
          { action: "hover", ...el }, { action: "click", ...el },
          { action: "press_key", key: "Enter" }, { action: "click", ...el },
          { action: "click", ...el },
        ] }]],
      }
    : {}),
  sequence_10: [
    ["browser_navigate", { url: "http://127.0.0.1/x" }],
    ["browser_click", el], ["browser_type", { ...el, text: "a", submit: false }],
    ["browser_click", el], ["browser_type", { ...el, text: "b", submit: false }],
    ["browser_hover", el], ["browser_click", el],
    ["browser_press_key", { key: "Enter" }], ["browser_click", el], ["browser_snapshot", {}],
  ],
};

function oneCall(client, name, a) {
  return client.callTool({ name, arguments: a }, undefined, { timeout: 60000 });
}
const textBytes = (r) =>
  (r.content ?? []).reduce((n, c) => n + Buffer.byteLength(c.text ?? c.data ?? ""), 0);

async function withServer(nodes, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, BROWSERMCP_PORT: String(port) },
    stderr: "pipe",
  });
  const client = new Client({ name: "bench", version: "0" });
  const tStart = performance.now();
  await client.connect(transport);
  // wait for WS server then attach mock extension
  let ext;
  for (let i = 0; i < 100 && !ext; i++) {
    try { ext = await startMockExtension({ port, rttMs, snapshotNodes: nodes, capabilities: caps }); }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  if (!ext) throw new Error("mock extension could not connect");
  const spawnToReadyMs = performance.now() - tStart;
  try { return await fn({ client, ext, pid: transport.pid, spawnToReadyMs }); }
  finally { ext.close(); await client.close().catch(() => {}); await new Promise((r) => setTimeout(r, 300)); }
}

function rssMb(pid) {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: "utf8" });
    return Math.round(Number(out) / 1048576);
  } catch { return null; }
}

const results = { target, label, caps, entry: path.relative(root, entry).split(path.sep).join("/"), rttMs, iterations, warmup, coldRuns, scenarios: {}, cold: null };

// Cold: fresh server process, latency of the very first tool call.
const coldSamples = [];
for (let i = 0; i < coldRuns; i++) {
  await withServer(SMALL, async ({ client }) => {
    const t = performance.now();
    await oneCall(client, "browser_snapshot", {});
    coldSamples.push(performance.now() - t);
  });
}
results.cold = { first_snapshot_ms: summarize(coldSamples) };

// Warm: per scenario, fresh server, warmup then measured iterations.
for (const [name, def] of Object.entries(scenarios)) {
  const nodes = def[1]?.nodes ?? SMALL;
  const steps = def.filter((s) => Array.isArray(s));
  await withServer(nodes, async ({ client, ext, pid }) => {
    for (let i = 0; i < warmup; i++) for (const [n, a] of steps) await oneCall(client, n, a);
    ext.stats.messages = 0; ext.stats.byType = {};
    const lat = [], bytes = [];
    let failures = 0;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      let b = 0;
      try {
        for (const [n, a] of steps) {
          const r = await oneCall(client, n, a);
          if (r.isError) failures++;
          b += textBytes(r);
        }
      } catch { failures++; }
      lat.push(performance.now() - t);
      bytes.push(b);
    }
    const wall = performance.now() - t0;
    results.scenarios[name] = {
      tool_calls_per_iter: steps.length,
      latency_ms: summarize(lat),
      response_bytes: summarize(bytes),
      ws_round_trips_per_iter: ext.stats.messages / iterations,
      ws_by_type: ext.stats.byType,
      iterations_per_sec: iterations / (wall / 1000),
      failure_rate: failures / (iterations * steps.length),
      server_rss_mb: rssMb(pid),
    };
    console.error(`${target} ${name}: median ${results.scenarios[name].latency_ms.median.toFixed(1)}ms p95 ${results.scenarios[name].latency_ms.p95.toFixed(1)}ms rt/iter ${results.scenarios[name].ws_round_trips_per_iter}`);
  });
}

// Repeated: 100 sequential calls on the same connected tab.
await withServer(SMALL, async ({ client }) => {
  const lat = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await oneCall(client, "browser_click", el);
    lat.push(performance.now() - t);
  }
  results.scenarios.repeated_100_clicks = { latency_ms: summarize(lat), first_10_median: summarize(lat.slice(0, 10)).median, last_10_median: summarize(lat.slice(-10)).median };
});

results.env = {
  node: process.version, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model,
  cores: os.cpus().length, totalMemGb: Math.round(os.totalmem() / 2 ** 30),
  date: new Date().toISOString(),
  notes: "Mock extension: extension-side time is SIMULATED (rttMs per message). Measures server+protocol overhead only, not Chrome.",
};
mkdirSync(path.join(here, "../results"), { recursive: true });
const file = path.join(here, "../results", `${target}-${label}-mock-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.error("wrote", file);
