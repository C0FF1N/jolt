import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { Context } from "@/context";
import { captureAriaSnapshot } from "@/utils/aria-snapshot";

import { type Action, perform } from "./actions";
import type { Tool, ToolResult } from "./tool";

/** Shape shared by every tool definition in @repo/types/mcp/tool. */
type ToolDef = {
  shape: {
    name: { value: string };
    description: { value: string };
    arguments: z.AnyZodObject;
  };
};

/** Optional argument added to action tools (additive; default keeps old behaviour). */
export const snapshotArg = z
  .enum(["full", "none"])
  .optional()
  .describe(
    "Return the page snapshot after the action (default full). Use none to skip it when you don't need it.",
  );

type Mode = "status+snapshot" | "snapshot-only";

/**
 * Builds a tool that runs one shared primitive and then (optionally) returns a
 * fresh snapshot. `snapshot-only` mirrors upstream navigate/back/forward output;
 * `status+snapshot` mirrors click/hover/type/select output.
 */
export function defineActionTool(
  def: ToolDef,
  toAction: (args: any) => Action,
  mode: Mode,
  snapshotByDefault = true,
): Tool {
  const args = def.shape.arguments.extend({ snapshot: snapshotArg });
  return {
    schema: {
      name: def.shape.name.value,
      description: def.shape.description.value,
      inputSchema: zodToJsonSchema(args),
    },
    handle: async (context: Context, params): Promise<ToolResult> => {
      const { snapshot, ...rest } = args.parse(params ?? {});
      const status = await perform(context, toAction(rest));
      const wantSnapshot = snapshot ? snapshot === "full" : snapshotByDefault;
      if (!wantSnapshot) {
        return { content: [{ type: "text", text: status }] };
      }
      const snap = await captureAriaSnapshot(context);
      return mode === "snapshot-only"
        ? snap
        : { content: [{ type: "text", text: status }, ...snap.content] };
    },
  };
}
