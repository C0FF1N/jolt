// One-command setup: registers the built Jolt server with Claude Code and VS Code,
// then tells you the one manual step left (loading the extension).
//
//   node scripts/setup.mjs [--claude] [--vscode] [--name=jolt] [--npx] [--force] [--dry-run]
//
// --npx registers `npx -y jolt-mcp` (the published package) instead of the build in this checkout.
// With neither --claude nor --vscode, both are attempted. An existing entry with the same name is
// left alone unless --force. A VS Code config that cannot be parsed (comments, trailing commas) is
// never rewritten: the snippet to paste is printed instead. Nothing is written in --dry-run.
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where VS Code keeps the user-level MCP config on this platform. */
export function vscodeUserConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Code", "User", "mcp.json");
}

/**
 * Pure merge of one stdio server into VS Code's mcp.json text.
 * Returns { action: "added" | "exists" | "replaced" | "unparsable", text? }.
 */
export function mergeVsCodeConfig(existingText, name, entry, { force = false } = {}) {
  let json = { servers: {} };
  if (existingText !== undefined && existingText.trim() !== "") {
    try {
      json = JSON.parse(existingText);
    } catch {
      return { action: "unparsable" };
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) return { action: "unparsable" };
  }
  if (json.servers !== undefined && (json.servers === null || typeof json.servers !== "object" || Array.isArray(json.servers))) {
    return { action: "unparsable" }; // "servers" is not a map: refuse rather than silently reshape the user's file
  }
  const servers = json.servers ?? {};
  const had = Object.hasOwn(servers, name);
  if (had && !force) return { action: "exists" };
  const next = { ...json, servers: { ...servers, [name]: entry } };
  return { action: had ? "replaced" : "added", text: `${JSON.stringify(next, null, 2)}\n` };
}

function parseArgs(argv) {
  const flags = Object.fromEntries(
    argv.map((a) => {
      const [k, v = "true"] = a.replace(/^--/, "").split("=");
      return [k, v];
    }),
  );
  const none = !flags.claude && !flags.vscode;
  const name = flags.name ?? "jolt";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    console.error('--name must start with a letter or digit and contain only letters, digits, ".", "_" and "-".');
    process.exit(1);
  }
  return {
    claude: none || Boolean(flags.claude),
    vscode: none || Boolean(flags.vscode),
    name,
    force: Boolean(flags.force),
    dry: Boolean(flags["dry-run"]),
    npx: Boolean(flags.npx),
  };
}

// On Windows `claude` is a .cmd shim, which only a shell can launch. Every argument is double-quoted
// (names are validated in parseArgs, paths cannot contain quotes on Windows).
const q = (s) => `"${String(s)}"`;
function run(cmd, args) {
  // cmd.exe would otherwise look in the current directory before PATH (a planted claude.cmd would run).
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" };
  const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env };
  return process.platform === "win32"
    ? execSync([cmd, ...args.map(q)].join(" "), opts)
    : execFileSync(cmd, args, opts);
}

function findServer() {
  for (const f of ["apps/server/dist/jolt-server.mjs", "apps/server/dist/index.js"]) {
    const p = path.join(root, f);
    if (existsSync(p)) return p.replaceAll("\\", "/");
  }
  return undefined;
}

/** The command + args an MCP client should launch. */
export function launchSpec({ npx }, server, platform = process.platform) {
  if (!npx) return { command: "node", args: [server] };
  return { command: "npx", args: ["-y", "jolt-mcp"], windowsWrapped: platform === "win32" };
}

function setupClaude(opts, server) {
  const { name, force, dry } = opts;
  const spec = launchSpec(opts, server);
  // Claude Code on native Windows needs `cmd /c` to start an npx server.
  const argv = spec.windowsWrapped ? ["cmd", "/c", spec.command, ...spec.args] : [spec.command, ...spec.args];
  let installed = true;
  try {
    run("claude", ["--version"]);
  } catch {
    installed = false;
  }
  if (!installed) return "skipped: the `claude` CLI was not found on PATH (install Claude Code, then re-run)";
  let exists = true;
  try {
    run("claude", ["mcp", "get", name]);
  } catch {
    exists = false;
  }
  if (exists && !force) return `already registered as "${name}" (use --force to replace it)`;
  if (dry) return `would run: claude mcp add --scope user ${name} -- ${argv.join(" ")}`;
  // --force is remove-then-add: if `add` fails the old entry is already gone, so re-run to retry.
  if (exists) run("claude", ["mcp", "remove", name, "--scope", "user"]);
  run("claude", ["mcp", "add", "--scope", "user", name, "--", ...argv]);
  return `registered "${name}" for all your projects (user scope)`;
}

function setupVsCode(opts, server) {
  const { name, force, dry } = opts;
  const file = vscodeUserConfigPath();
  const { command, args } = launchSpec(opts, server);
  const entry = { type: "stdio", command, args };
  const existing = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const merged = mergeVsCodeConfig(existing, name, entry, { force });
  const snippet = JSON.stringify({ servers: { [name]: entry } }, null, 2);
  if (merged.action === "unparsable") {
    return `could not safely edit ${file} (comments or invalid JSON). Add this under "servers" yourself:\n${snippet}`;
  }
  if (merged.action === "exists") return `already in ${file} (use --force to replace it)`;
  if (dry) return `would ${merged.action === "added" ? "add it to" : "replace it in"} ${file}`;
  mkdirSync(path.dirname(file), { recursive: true });
  if (existing !== undefined) copyFileSync(file, `${file}.bak-${Date.now()}`);
  writeFileSync(file, merged.text);
  const note = existing === undefined ? "created" : "the previous file was copied to a timestamped .bak next to it; delete old backups when done";
  return `${merged.action} in ${file} (${note})`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = findServer();
  const ext = path.join(root, "apps/extension/dist");
  const haveBuild = Boolean(server) && existsSync(path.join(ext, "manifest.json"));
  if (!opts.npx && !haveBuild) {
    console.error("Build output not found. Run:  pnpm install && pnpm -r build   (or use --npx to register the published package)");
    process.exit(1);
  }
  console.log(`Jolt setup${opts.dry ? " (dry run: nothing will be changed)" : ""}\n`);
  if (opts.claude) console.log(`Claude Code : ${setupClaude(opts, server)}`);
  if (opts.vscode) console.log(`VS Code     : ${setupVsCode(opts, server)}`);
  console.log(`
Last step (once): install the extension in Chrome
${haveBuild ? `  chrome://extensions  ->  Developer mode  ->  Load unpacked  ->\n  ${ext}` : "  Install Jolt from the Chrome Web Store, or load the zip from the GitHub releases unpacked."}

Then restart Claude Code / reload VS Code, open the page you want automated, click the
Jolt icon and press "Connect this tab". It finds the right client by itself,
and reconnects on its own if the client restarts.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
