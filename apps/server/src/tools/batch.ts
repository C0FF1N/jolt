import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Context } from "@/context";
import { BrowserMcpError } from "@/errors";
import { captureAriaSnapshot, capturePageSummary } from "@/utils/aria-snapshot";
import { now } from "@/utils/trace";

import { type Action, ActionSchema, perform } from "./actions";
import type { Tool, ToolResult } from "./tool";

export const MAX_BATCH_ACTIONS = 20;
const DEFAULT_BATCH_TIMEOUT_MS = 60_000;
const MAX_BATCH_TIMEOUT_MS = 300_000;

const BatchArgs = z.object({
  actions: z
    .array(z.unknown())
    .min(1)
    .max(MAX_BATCH_ACTIONS)
    .describe(
      `1-${MAX_BATCH_ACTIONS} actions run strictly in order. Each: {action: navigate|go_back|go_forward|click|hover|type|select_option|press_key|wait|wait_for, ...args}. click/hover/type/select_option need element+ref from a prior snapshot.`,
    ),
  onError: z
    .enum(["stop", "continue"])
    .optional()
    .describe("stop (default): skip remaining actions after a failure. continue: keep going."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(MAX_BATCH_TIMEOUT_MS)
    .optional()
    .describe("Total time budget for the whole batch (default 60000)."),
  finalSnapshot: z
    .enum(["none", "summary", "full"])
    .optional()
    .describe("After the batch: none, summary (URL + title, default) or full accessibility snapshot."),
});

type StepResult = {
  index: number;
  action: string;
  status: "ok" | "failed" | "skipped";
  message?: string;
  error?: { code: string; message: string; hint?: string };
  durationMs?: number;
};

export type BatchOutcome = {
  ok: boolean;
  completed: number;
  failed: number;
  skipped: number;
  results: StepResult[];
};

/**
 * Validates the whole batch first (nothing runs if any action is invalid),
 * then runs actions sequentially: later actions depend on earlier ones, so
 * they are never concurrent. Every action goes through the same `perform`
 * primitive as the standalone tools. No per-action snapshots.
 */
export async function runBatch(
  context: Context,
  rawActions: unknown[],
  opts: { onError: "stop" | "continue"; timeoutMs: number },
): Promise<BatchOutcome> {
  const actions: Action[] = rawActions.map((raw, i) => {
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BrowserMcpError(
        "INVALID_ARGUMENT",
        `actions[${i}] is invalid: ${issue.path.join(".") || "action"}: ${issue.message}`,
        "browser_batch",
        "Fix the action and resend; no actions were executed.",
      );
    }
    return parsed.data;
  });

  const results: StepResult[] = [];
  const deadline = now() + opts.timeoutMs;
  let stopped = false;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (stopped) {
      results.push({ index: i, action: a.action, status: "skipped" });
      continue;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      results.push({
        index: i,
        action: a.action,
        status: "failed",
        error: {
          code: "TIMEOUT",
          message: `Batch time budget of ${opts.timeoutMs}ms was exhausted before this action.`,
          hint: "Split the batch or raise timeoutMs.",
        },
      });
      stopped = true;
      continue;
    }
    const startedAt = now();
    try {
      const message = await perform(context, a, { deadlineMs: Math.ceil(remaining) });
      results.push({
        index: i,
        action: a.action,
        status: "ok",
        message,
        durationMs: Math.round(now() - startedAt),
      });
    } catch (e) {
      const err =
        e instanceof BrowserMcpError
          ? { code: e.code, message: e.message, hint: e.hint }
          : { code: "EXTENSION_ERROR", message: String(e) };
      results.push({
        index: i,
        action: a.action,
        status: "failed",
        error: err,
        durationMs: Math.round(now() - startedAt),
      });
      if (opts.onError === "stop") stopped = true;
    }
  }

  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return {
    ok: failed === 0,
    completed: results.filter((r) => r.status === "ok").length,
    failed,
    skipped,
    results,
  };
}

export const batch: Tool = {
  schema: {
    name: "browser_batch",
    description:
      "Run several browser actions in one call, in order, and return a result per action. Use it for known sequences (fill a form, then submit). Refs must come from a prior snapshot.",
    inputSchema: zodToJsonSchema(BatchArgs),
  },
  handle: async (context, params): Promise<ToolResult> => {
    const args = BatchArgs.parse(params ?? {});
    const outcome = await runBatch(context, args.actions, {
      onError: args.onError ?? "stop",
      timeoutMs: args.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS,
    });
    const content: ToolResult["content"] = [
      { type: "text", text: JSON.stringify(outcome) },
    ];
    const finalMode = args.finalSnapshot ?? "summary";
    try {
      if (finalMode === "full") {
        content.push(...(await captureAriaSnapshot(context)).content);
      } else if (finalMode === "summary") {
        const page = await capturePageSummary(context);
        content.push({ type: "text", text: JSON.stringify({ page }) });
      }
    } catch (e) {
      content.push({
        type: "text",
        text: `Final page state unavailable: ${e instanceof BrowserMcpError ? e.message : String(e)}`,
      });
    }
    return { content, isError: !outcome.ok };
  },
};
