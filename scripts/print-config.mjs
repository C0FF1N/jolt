// Prints ready-to-paste setup for this checkout: extension folder, MCP server command, client configs.
// Usage: node scripts/print-config.mjs [--port=9010] [--name=jolt]
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
const name = args.name ?? "jolt";
const port = args.port ? Number(args.port) : undefined;
if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
  console.error("--port must be an integer between 1024 and 65535");
  process.exit(1);
}

const bundle = path.join(root, "apps/server/dist/jolt-server.mjs");
const plain = path.join(root, "apps/server/dist/index.js");
const server = (existsSync(bundle) ? bundle : plain).replaceAll("\\", "/");
const ext = path.join(root, "apps/extension/dist");

if (!existsSync(server) || !existsSync(path.join(ext, "manifest.json"))) {
  console.error("Build output not found. Run:  pnpm install && pnpm -r build");
  process.exit(1);
}

const envPart = port ? ` -e JOLT_PORT=${port}` : "";
const jsonEnv = port ? { env: { JOLT_PORT: String(port) } } : {};

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

3) Restart the client, open the page to automate, click the extension icon, then "Connect this tab".
   ${port ? `The server is pinned to port ${port} (JOLT_PORT): open "Advanced" in the popup and enter ${port} as the fixed port.` : "No port to type: the extension finds the server by itself (ports 9470-9480), so several clients can run at once."}

Shortcut: \`pnpm run setup\` does step 2 for Claude Code and VS Code automatically.
`);
