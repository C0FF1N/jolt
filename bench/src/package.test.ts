// Tests the artifact people actually run: the single-file bundle (what `npx jolt-mcp` executes),
// started from an empty directory so nothing can resolve from node_modules.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundle = path.join(root, "apps/server/dist/jolt-server.mjs");
const running: ChildProcess[] = [];

afterEach(() => {
  while (running.length) running.pop()!.kill();
});

/** Starts the bundle with exactly these Jolt-related env vars and resolves with its /info. */
async function startAndAsk(port: number, env: Record<string, string>) {
  const clean = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(clean)) if (/^(JOLT|BROWSERMCP)_/.test(k)) delete clean[k];
  const child = spawn(process.execPath, [bundle], { cwd: os.tmpdir(), env: { ...clean, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  running.push(child);
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  for (let i = 0; i < 60 && !stderr.includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
  const res = await fetch(`http://127.0.0.1:${port}/info`, { signal: AbortSignal.timeout(2000) });
  return { info: await res.json(), stderr };
}

describe.skipIf(!existsSync(bundle))("shipped single-file bundle", () => {
  it("starts with no node_modules and identifies itself as Jolt", async () => {
    const { info, stderr } = await startAndAsk(19960, { JOLT_PORT: "19960" });
    expect(info).toMatchObject({ name: "Jolt", port: 19960, protocolVersion: 2 });
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(stderr).toContain("[Jolt] ready");
  });

  it("still honours the legacy BROWSERMCP_PORT name", async () => {
    const { info } = await startAndAsk(19961, { BROWSERMCP_PORT: "19961" });
    expect(info.port).toBe(19961);
  });

  it("prefers JOLT_PORT over the legacy name when both are set", async () => {
    const { info } = await startAndAsk(19962, { JOLT_PORT: "19962", BROWSERMCP_PORT: "19999" });
    expect(info.port).toBe(19962);
  });

  it("has a shebang so the npm bin runs directly", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
