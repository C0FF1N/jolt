import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  ClickTool,
  DragTool,
  HoverTool,
  SelectOptionTool,
  SnapshotTool,
  TypeTool,
} from "@repo/types/mcp/tool";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import { defineActionTool } from "./define";
import type { Tool } from "./tool";

const snapshotArgs = SnapshotTool.shape.arguments.extend({
  maxChars: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Max characters of snapshot to return (0 = unlimited). Default 200000."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Continue a truncated snapshot from this character offset."),
});

export const snapshot: Tool = {
  schema: {
    name: SnapshotTool.shape.name.value,
    description: SnapshotTool.shape.description.value,
    inputSchema: zodToJsonSchema(snapshotArgs),
  },
  handle: async (context: Context, params) => {
    const { maxChars, offset } = snapshotArgs.parse(params ?? {});
    return await captureAriaSnapshot(context, { maxChars, offset });
  },
};

export const click: Tool = defineActionTool(
  ClickTool,
  (a) => ({ action: "click", element: a.element, ref: a.ref }),
  "status+snapshot",
);

export const hover: Tool = defineActionTool(
  HoverTool,
  (a) => ({ action: "hover", element: a.element, ref: a.ref }),
  "status+snapshot",
);

export const type: Tool = defineActionTool(
  TypeTool,
  (a) => ({
    action: "type",
    element: a.element,
    ref: a.ref,
    text: a.text,
    submit: a.submit,
  }),
  "status+snapshot",
);

export const selectOption: Tool = defineActionTool(
  SelectOptionTool,
  (a) => ({
    action: "select_option",
    element: a.element,
    ref: a.ref,
    values: a.values,
  }),
  "status+snapshot",
);

/** Not registered upstream either (see index.ts); kept for parity. */
export const drag: Tool = {
  schema: {
    name: DragTool.shape.name.value,
    description: DragTool.shape.description.value,
    inputSchema: zodToJsonSchema(DragTool.shape.arguments),
  },
  handle: async (context: Context, params) => {
    const validatedParams = DragTool.shape.arguments.parse(params);
    await context.sendSocketMessage("browser_drag", validatedParams);
    const snap = await captureAriaSnapshot(context);
    return {
      content: [
        {
          type: "text",
          text: `Dragged "${validatedParams.startElement}" to "${validatedParams.endElement}"`,
        },
        ...snap.content,
      ],
    };
  },
};
