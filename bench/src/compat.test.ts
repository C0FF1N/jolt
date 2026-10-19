// Compatibility: every upstream tool must still exist with an inputSchema that
// is a backwards-compatible superset (same required list, original properties
// unchanged). Spawns both built servers over MCP stdio; skipped if not built.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const baselineEntry = path.join(root, "baseline/dist/index.js");
const turboEntry = path.join(root, "apps/server/dist/index.js");
const built = existsSync(baselineEntry) && existsSync(turboEntry);

async function listTools(entry: string, port: number) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, JOLT_PORT: String(port) } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "compat", version: "0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe.skipIf(!built)("tool contract vs upstream baseline", () => {
  it("keeps every upstream tool name, description and original schema", async () => {
    const [base, turbo] = await Promise.all([
      listTools(baselineEntry, 19311),
      listTools(turboEntry, 19312),
    ]);
    const turboByName = new Map(turbo.map((t) => [t.name, t]));
    for (const b of base) {
      const t = turboByName.get(b.name);
      expect(t, `missing tool ${b.name}`).toBeDefined();
      expect(t!.description).toBe(b.description);
      const bs = b.inputSchema as any;
      const ts = t!.inputSchema as any;
      expect(ts.required ?? []).toEqual(bs.required ?? []);
      for (const [prop, def] of Object.entries(bs.properties ?? {})) {
        expect(ts.properties?.[prop], `${b.name}.${prop}`).toEqual(def);
      }
    }
  });

  it("only adds the documented new tools", async () => {
    const [base, turbo] = await Promise.all([
      listTools(baselineEntry, 19313),
      listTools(turboEntry, 19314),
    ]);
    const added = turbo
      .map((t) => t.name)
      .filter((n) => !base.some((b) => b.name === n))
      .sort();
    expect(added).toEqual(["browser_batch", "browser_wait_for"]);
  });

  it("only adds optional properties to existing tools", async () => {
    const [base, turbo] = await Promise.all([
      listTools(baselineEntry, 19315),
      listTools(turboEntry, 19316),
    ]);
    for (const b of base) {
      const t = turbo.find((x) => x.name === b.name)!;
      const extra = Object.keys((t.inputSchema as any).properties ?? {}).filter(
        (p) => !((b.inputSchema as any).properties ?? {})[p],
      );
      for (const p of extra) {
        expect((t.inputSchema as any).required ?? []).not.toContain(p);
      }
    }
  });
});
