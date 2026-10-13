// Prints ready-to-paste setup for this checkout: extension folder, MCP server command, client configs.
// Usage: node scripts/print-config.mjs [--port=9010] [--name=browsermcp-turbo]
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "true"] = a.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const name = args.name ?? "browsermcp-turbo";
const port = args.port ? Number(args.port) : undefined;
if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
  console.error("--port must be an integer between 1024 and 65535");
  process.exit(1);
}

const bundle = path.join(root, "apps/server/dist/browsermcp-turbo.mjs");
const plain = path.join(root, "apps/server/dist/index.js");
const server = (existsSync(bundle) ? bundle : plain).replaceAll("\\", "/");
const ext = path.join(root, "apps/extension/dist");

if (!existsSync(server) || !existsSync(path.join(ext, "manifest.json"))) {
  console.error("Build output not found. Run:  pnpm install && pnpm run quickstart");
  process.exit(1);
}

const envPart = port ? ` -e BROWSERMCP_PORT=${port}` : "";
const jsonEnv = port ? { env: { BROWSERMCP_PORT: String(port) } } : {};

console.log(`
1) Load the extension (once):
   chrome://extensions  ->  Developer mode  ->  Load unpacked  ->
   ${ext}

2) Register the MCP server with your client.

   Claude Code:
   claude mcp add ${name}${envPart} -- node ${server}

   Claude Desktop / Cursor / Windsurf (mcpServers JSON):
${JSON.stringify({ mcpServers: { [name]: { command: "node", args: [server], ...jsonEnv } } }, null, 2)
  .split("\n")
  .map((l) => "   " + l)
  .join("\n")}

   VS Code (.vscode/mcp.json):
${JSON.stringify({ servers: { [name]: { type: "stdio", command: "node", args: [server], ...jsonEnv } } }, null, 2)
  .split("\n")
  .map((l) => "   " + l)
  .join("\n")}

3) Restart the client, open the page to automate, click the extension icon,
   ${port ? `set Server port to ${port}, ` : "keep Server port 9009 (or match BROWSERMCP_PORT), "}then "Connect this tab".
`);
