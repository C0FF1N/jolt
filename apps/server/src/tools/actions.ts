import { z } from "zod";

import { BrowserMcpError } from "@/errors";
import type { Context } from "@/context";

const element = z.object({
  element: z.string().describe(
    "Human-readable element description used to obtain permission to interact with the element",
  ),
  ref: z.string().describe("Exact target element reference from the page snapshot"),
});

/**
 * The single list of primitives shared by individual tools and browser_batch,
 * so a batched action is validated and executed exactly like a standalone one.
 * Deliberately no arbitrary-JavaScript action.
 */
export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string() }),
  z.object({ action: z.literal("go_back") }),
  z.object({ action: z.literal("go_forward") }),
  element.extend({ action: z.literal("click") }),
  element.extend({ action: z.literal("hover") }),
  element.extend({
    action: z.literal("type"),
    text: z.string(),
    submit: z.boolean().optional(),
  }),
  element.extend({
    action: z.literal("select_option"),
    values: z.array(z.string()),
  }),
  z.object({ action: z.literal("press_key"), key: z.string() }),
  z.object({ action: z.literal("wait"), time: z.number().min(0).max(300) }),
  z.object({
    action: z.literal("wait_for"),
    text: z.string().min(1).max(500).optional(),
    textGone: z.string().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  }),
]);

export type Action = z.infer<typeof ActionSchema>;

const WAIT_FOR_DEFAULT_MS = 10_000;
/** Slack added on top of an operation's own duration for transport latency. */
const TRANSPORT_SLACK_MS = 10_000;

/** Executes one primitive and returns a short human-readable status line. */
export async function perform(
  context: Context,
  a: Action,
  opts: { deadlineMs?: number } = {},
): Promise<string> {
  const cap = (ms: number) =>
    opts.deadlineMs === undefined ? ms : Math.max(1, Math.min(ms, opts.deadlineMs));
  switch (a.action) {
    case "navigate":
      await context.sendSocketMessage("browser_navigate", { url: a.url }, { timeoutMs: cap(30_000) });
      return `Navigated to ${a.url}`;
    case "go_back":
      await context.sendSocketMessage("browser_go_back", {}, { timeoutMs: cap(30_000) });
      return "Navigated back";
    case "go_forward":
      await context.sendSocketMessage("browser_go_forward", {}, { timeoutMs: cap(30_000) });
      return "Navigated forward";
    case "click":
      await context.sendSocketMessage("browser_click", { element: a.element, ref: a.ref }, { timeoutMs: cap(30_000) });
      return `Clicked "${a.element}"`;
    case "hover":
      await context.sendSocketMessage("browser_hover", { element: a.element, ref: a.ref }, { timeoutMs: cap(30_000) });
      return `Hovered over "${a.element}"`;
    case "type":
      await context.sendSocketMessage(
        "browser_type",
        { element: a.element, ref: a.ref, text: a.text, submit: a.submit ?? false },
        { timeoutMs: cap(30_000) },
      );
      return `Typed "${a.text}" into "${a.element}"`;
    case "select_option":
      await context.sendSocketMessage(
        "browser_select_option",
        { element: a.element, ref: a.ref, values: a.values },
        { timeoutMs: cap(30_000) },
      );
      return `Selected option in "${a.element}"`;
    case "press_key":
      await context.sendSocketMessage("browser_press_key", { key: a.key }, { timeoutMs: cap(30_000) });
      return `Pressed key ${a.key}`;
    case "wait":
      // Upstream used the fixed 30s transport timeout, so waits > 30s always failed.
      await context.sendSocketMessage(
        "browser_wait",
        { time: a.time },
        { timeoutMs: cap(a.time * 1000 + TRANSPORT_SLACK_MS) },
      );
      return `Waited for ${a.time} seconds`;
    case "wait_for": {
      if (!a.text && !a.textGone) {
        throw new BrowserMcpError(
          "INVALID_ARGUMENT",
          "wait_for needs `text` (wait until it appears) or `textGone` (wait until it disappears).",
          "wait_for",
        );
      }
      if (!context.link.has("waitFor")) {
        throw new BrowserMcpError(
          "UNSUPPORTED",
          "The connected extension does not support condition waits.",
          "wait_for",
          "Use browser_wait with a fixed time, or connect with the Browser MCP Turbo extension.",
        );
      }
      const timeoutMs = a.timeoutMs ?? WAIT_FOR_DEFAULT_MS;
      const condition = a.text ? `text "${a.text}" to appear` : `text "${a.textGone}" to disappear`;
      try {
        await context.sendCustom(
          "browser_wait_for",
          { text: a.text, textGone: a.textGone, timeoutMs },
          { timeoutMs: cap(timeoutMs + TRANSPORT_SLACK_MS) },
        );
      } catch (e) {
        if (e instanceof BrowserMcpError && (e.code === "TIMEOUT" || /timed out/i.test(e.message))) {
          throw new BrowserMcpError(
            "TIMEOUT",
            `Timed out after ${timeoutMs}ms waiting for ${condition}.`,
            "wait_for",
            "Take a snapshot to see the current page state, or increase timeoutMs.",
          );
        }
        throw e;
      }
      return `Condition met: ${condition}`;
    }
  }
}
