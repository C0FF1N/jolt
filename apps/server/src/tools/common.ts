import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  GoBackTool,
  GoForwardTool,
  NavigateTool,
  PressKeyTool,
  WaitTool,
} from "@repo/types/mcp/tool";

import { perform } from "./actions";
import { defineActionTool } from "./define";
import type { Tool, ToolFactory } from "./tool";

export const navigate: ToolFactory = (snapshot) =>
  defineActionTool(
    NavigateTool,
    (a) => ({ action: "navigate", url: a.url }),
    "snapshot-only",
    snapshot,
  );

export const goBack: ToolFactory = (snapshot) =>
  defineActionTool(GoBackTool, () => ({ action: "go_back" }), "snapshot-only", snapshot);

export const goForward: ToolFactory = (snapshot) =>
  defineActionTool(
    GoForwardTool,
    () => ({ action: "go_forward" }),
    "snapshot-only",
    snapshot,
  );

export const wait: Tool = {
  schema: {
    name: WaitTool.shape.name.value,
    description: WaitTool.shape.description.value,
    inputSchema: zodToJsonSchema(WaitTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { time } = WaitTool.shape.arguments.parse(params);
    const status = await perform(context, { action: "wait", time });
    return { content: [{ type: "text", text: status }] };
  },
};

export const pressKey: Tool = {
  schema: {
    name: PressKeyTool.shape.name.value,
    description: PressKeyTool.shape.description.value,
    inputSchema: zodToJsonSchema(PressKeyTool.shape.arguments),
  },
  handle: async (context, params) => {
    const { key } = PressKeyTool.shape.arguments.parse(params);
    const status = await perform(context, { action: "press_key", key });
    return { content: [{ type: "text", text: status }] };
  },
};

const WaitForArgs = z.object({
  text: z.string().min(1).max(500).optional().describe("Wait until this text appears on the page."),
  textGone: z.string().min(1).max(500).optional().describe("Wait until this text disappears."),
  timeoutMs: z.number().int().min(100).max(60000).optional().describe("Give up after this long (default 10000)."),
});

export const waitFor: Tool = {
  schema: {
    name: "browser_wait_for",
    description:
      "Wait for text to appear or disappear instead of sleeping a fixed time. Fails with a timeout error naming the condition.",
    inputSchema: zodToJsonSchema(WaitForArgs),
  },
  handle: async (context, params) => {
    const a = WaitForArgs.parse(params ?? {});
    const status = await perform(context, { action: "wait_for", ...a });
    return { content: [{ type: "text", text: status }] };
  },
};
