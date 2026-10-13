import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { Context } from "@/context";
import { BrowserMcpError } from "@/errors";
import type { Resource } from "@/resources/resource";
import type { Tool, ToolResult } from "@/tools/tool";
import { now, trace, withTrace } from "@/utils/trace";
import { createWebSocketServer } from "@/ws";

type Options = {
  name: string;
  version: string;
  tools: Tool[];
  resources: Resource[];
};

function errorResult(error: unknown): ToolResult {
  const text =
    error instanceof BrowserMcpError ? error.format() : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

function resultBytes(result: ToolResult): number {
  let n = 0;
  for (const c of result.content) {
    n += Buffer.byteLength(c.type === "text" ? c.text : c.data);
  }
  return n;
}

export async function createServerWithTools(options: Options): Promise<Server> {
  const { name, version, tools, resources } = options;
  const context = new Context();
  const server = new Server(
    { name, version },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  const wss = await createWebSocketServer();
  wss.on("connection", (websocket) => {
    // A new connection replaces (and rejects pending work on) the old one.
    context.attach(websocket);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => tool.schema) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: resources.map((resource) => resource.schema) };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    withTrace(async () => {
      const startedAt = now();
      const toolName = request.params.name;
      trace("mcp.received", { tool: toolName });
      const tool = tools.find((tool) => tool.schema.name === toolName);
      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `Tool "${toolName}" not found` }],
          isError: true,
        };
      }

      let result: ToolResult;
      try {
        result = await tool.handle(context, request.params.arguments);
      } catch (error) {
        result = errorResult(error);
      }
      trace("mcp.completed", {
        tool: toolName,
        durationMs: Math.round((now() - startedAt) * 100) / 100,
        bytes: resultBytes(result),
        isError: Boolean(result.isError),
      });
      return result;
    }),
  );

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.find(
      (resource) => resource.schema.uri === request.params.uri,
    );
    if (!resource) {
      return { contents: [] };
    }

    const contents = await resource.read(context, request.params.uri);
    return { contents };
  });

  // Upstream reassigned `server.close` to a function that called `server.close()`
  // (infinite recursion). Capture the original first.
  const closeProtocol = server.close.bind(server);
  server.close = async () => {
    await closeProtocol();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await context.close();
  };

  return server;
}
