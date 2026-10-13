import type { z } from "zod";

import type {
  ClickTool,
  DragTool,
  HoverTool,
  NavigateTool,
  PressKeyTool,
  SelectOptionTool,
  TypeTool,
  WaitTool,
} from "../mcp/tool";

type Args<T extends { shape: { arguments: z.ZodTypeAny } }> = z.infer<
  T["shape"]["arguments"]
>;

/**
 * Server -> extension request/response contract, reconstructed from how the
 * published @browsermcp/mcp@0.1.3 bundle uses it (the original type-only
 * module is erased from the bundle).
 */
export type SocketMessageMap = {
  getUrl: { request: undefined; response: string };
  getTitle: { request: undefined; response: string };
  browser_navigate: { request: Args<typeof NavigateTool>; response: void };
  browser_go_back: { request: Record<string, never>; response: void };
  browser_go_forward: { request: Record<string, never>; response: void };
  browser_wait: { request: Args<typeof WaitTool>; response: void };
  browser_press_key: { request: Args<typeof PressKeyTool>; response: void };
  browser_snapshot: { request: Record<string, never>; response: string };
  browser_click: { request: Args<typeof ClickTool>; response: void };
  browser_hover: { request: Args<typeof HoverTool>; response: void };
  browser_type: { request: Args<typeof TypeTool>; response: void };
  browser_select_option: {
    request: Args<typeof SelectOptionTool>;
    response: void;
  };
  browser_drag: { request: Args<typeof DragTool>; response: void };
  browser_screenshot: { request: Record<string, never>; response: string };
  browser_get_console_logs: {
    request: Record<string, never>;
    response: unknown[];
  };
};
