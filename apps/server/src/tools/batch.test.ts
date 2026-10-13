import { describe, expect, it } from "vitest";

import type { Context } from "@/context";
import { BrowserMcpError } from "@/errors";
import { MAX_BATCH_ACTIONS, batch, runBatch } from "@/tools/batch";

type Call = { type: string; payload: unknown };

/** Minimal Context double: records order, can fail or delay chosen types. */
function fakeContext(opts: {
  failOn?: (c: Call) => Error | undefined;
  delayMs?: number;
} = {}) {
  const calls: Call[] = [];
  const ctx = {
    link: { has: () => true },
    async sendSocketMessage(type: string, payload: unknown) {
      const call = { type, payload };
      calls.push(call);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const err = opts.failOn?.(call);
      if (err) throw err;
      if (type === "getUrl") return "http://x/";
      if (type === "getTitle") return "T";
      if (type === "browser_snapshot") return "- document";
      return undefined;
    },
    async sendCustom(type: string, payload: unknown) {
      calls.push({ type, payload });
      return undefined;
    },
  } as unknown as Context;
  return { ctx, calls };
}

const click = (n: string) => ({ action: "click", element: n, ref: "e1" });

describe("runBatch", () => {
  it("runs actions in order and reports each result", async () => {
    const { ctx, calls } = fakeContext();
    const out = await runBatch(ctx, [click("a"), { action: "press_key", key: "Enter" }], {
      onError: "stop",
      timeoutMs: 5000,
    });
    expect(out.ok).toBe(true);
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(calls.map((c) => c.type)).toEqual(["browser_click", "browser_press_key"]);
  });

  it("stops on failure and marks the rest skipped (never silently)", async () => {
    const { ctx, calls } = fakeContext({
      failOn: (c) => (c.type === "browser_click" ? new BrowserMcpError("EXTENSION_ERROR", "Element not found", c.type) : undefined),
    });
    const out = await runBatch(ctx, [click("a"), click("b"), click("c")], { onError: "stop", timeoutMs: 5000 });
    expect(out.results.map((r) => r.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(out.results[0].error?.code).toBe("EXTENSION_ERROR");
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, failed: 1, skipped: 2, completed: 0 });
  });

  it("continues past a failure when onError=continue", async () => {
    let n = 0;
    const { ctx } = fakeContext({
      failOn: () => (++n === 1 ? new Error("boom") : undefined),
    });
    const out = await runBatch(ctx, [click("a"), click("b")], { onError: "continue", timeoutMs: 5000 });
    expect(out.results.map((r) => r.status)).toEqual(["failed", "ok"]);
  });

  it("rejects an invalid action before executing anything", async () => {
    const { ctx, calls } = fakeContext();
    await expect(
      runBatch(ctx, [click("a"), { action: "evaluate", code: "alert(1)" }], { onError: "stop", timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });

  it("has no arbitrary-JavaScript action", async () => {
    const { ctx } = fakeContext();
    await expect(
      runBatch(ctx, [{ action: "eval", expression: "1" }], { onError: "stop", timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(BrowserMcpError);
  });

  it("fails the first action past the budget with TIMEOUT and skips the rest", async () => {
    const { ctx } = fakeContext({ delayMs: 60 });
    const out = await runBatch(ctx, [click("a"), click("b"), click("c"), click("d")], {
      onError: "stop",
      timeoutMs: 100,
    });
    const statuses = out.results.map((r) => r.status);
    const firstFailed = statuses.indexOf("failed");
    expect(firstFailed).toBeGreaterThan(0); // something ran before the budget ended
    expect(out.results[firstFailed].error?.code).toBe("TIMEOUT");
    expect(statuses.slice(firstFailed + 1).every((s) => s === "skipped")).toBe(true);
    expect(statuses.slice(0, firstFailed).every((s) => s === "ok")).toBe(true);
  });

  it("executes strictly sequentially (dependent actions never overlap)", async () => {
    let active = 0;
    let maxActive = 0;
    const ctx = {
      link: { has: () => true },
      async sendSocketMessage() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
    } as unknown as Context;
    await runBatch(ctx, [click("a"), click("b"), click("c")], { onError: "stop", timeoutMs: 5000 });
    expect(maxActive).toBe(1);
  });
});

describe("browser_batch tool", () => {
  it("rejects more than the maximum number of actions", async () => {
    const { ctx } = fakeContext();
    const many = Array.from({ length: MAX_BATCH_ACTIONS + 1 }, () => click("a"));
    await expect(batch.handle(ctx, { actions: many })).rejects.toThrow();
  });

  it("returns structured results plus a page summary, no per-action snapshots", async () => {
    const { ctx, calls } = fakeContext();
    const res = await batch.handle(ctx, { actions: [click("a"), click("b")] });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.results).toHaveLength(2);
    expect(calls.filter((c) => c.type === "browser_snapshot")).toHaveLength(0);
    expect(calls.map((c) => c.type)).toEqual(["browser_click", "browser_click", "getUrl", "getTitle"]);
  });

  it("flags isError when any action failed", async () => {
    const { ctx } = fakeContext({ failOn: () => new Error("x") });
    const res = await batch.handle(ctx, { actions: [click("a")] });
    expect(res.isError).toBe(true);
  });
});
