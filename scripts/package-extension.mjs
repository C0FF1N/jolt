// Builds the extension, checks it against the Chrome Web Store's rules, and writes
// release/jolt-extension-<version>.zip (+ a SHA-256) ready to upload to the developer dashboard.
//
//   node scripts/package-extension.mjs [--no-build]
//
// Fails (non-zero exit) on anything the store would reject or that would surprise a reviewer.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createZip } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps/extension/dist");

/** Every permission the extension is allowed to ask for, with why. Adding one must be a deliberate edit here. */
export const ALLOWED_PERMISSIONS = {
  debugger: "drives the one tab the user connects (click, type, snapshot, screenshot)",
  tabs: "reads the connected tab's URL and title and finds the active tab for the popup",
  storage: "remembers the cursor toggle, the last server port and the armed session",
  alarms: "wakes the service worker to reconnect after Chrome evicts it",
};
export const ALLOWED_HOSTS = ["http://127.0.0.1/*"];

/** Pure checks over a parsed manifest; returns a list of problems (empty = fine). */
export function checkManifest(m, exists = () => true) {
  const problems = [];
  const need = (cond, msg) => cond || problems.push(msg);
  need(m.manifest_version === 3, "manifest_version must be 3");
  need(typeof m.name === "string" && m.name.length > 0 && m.name.length <= 75, "name must be 1-75 characters");
  need(typeof m.short_name === "string" && m.short_name.length <= 12, "short_name must be at most 12 characters");
  need(typeof m.description === "string" && m.description.length > 0 && m.description.length <= 132, "description must be 1-132 characters");
  need(
    /^\d+(\.\d+){0,3}$/.test(m.version ?? "") && m.version.split(".").every((n) => Number(n) <= 65535 && (n === "0" || !n.startsWith("0"))) && m.version.split(".").some((n) => n !== "0"),
    "version must be 1-4 dot-separated integers (0-65535, no leading zeros, not all zero)",
  );
  need(/^https:\/\//.test(m.homepage_url ?? ""), "homepage_url must be an https URL");
  need(!("author" in m), 'drop the "author" key: Chrome ignores it (publisher name is set in the dashboard)');
  need(!("content_scripts" in m) && !("externally_connectable" in m) && !("web_accessible_resources" in m), "no content scripts, externally_connectable or web_accessible_resources are expected");
  need(!("content_security_policy" in m), "do not loosen the default content security policy");
  for (const p of m.permissions ?? []) need(p in ALLOWED_PERMISSIONS, `permission "${p}" is not in ALLOWED_PERMISSIONS (unused or unjustified permissions are rejected by the store)`);
  for (const p of Object.keys(ALLOWED_PERMISSIONS)) need((m.permissions ?? []).includes(p), `permission "${p}" is listed as needed but missing from the manifest`);
  for (const h of m.host_permissions ?? []) need(ALLOWED_HOSTS.includes(h), `host permission "${h}" is not allowed (loopback only)`);
  need(!("optional_permissions" in m) && !("optional_host_permissions" in m), "no optional permissions are expected");
  const files = [
    m.background?.service_worker,
    m.action?.default_popup,
    ...Object.values(m.icons ?? {}),
    ...Object.values(m.action?.default_icon ?? {}),
  ].filter(Boolean);
  for (const f of files) need(exists(f), `manifest references a missing file: ${f}`);
  for (const size of ["16", "32", "48", "128"]) need(m.icons?.[size], `icons.${size} is missing`);
  return problems;
}

/** Scans shipped JS for patterns that trigger the store's remote-code / obfuscation rejections. */
export function checkCode(files) {
  const problems = [];
  for (const { name, text } of files) {
    if (!name.endsWith(".js")) continue;
    if (/\beval\s*\(/.test(text)) problems.push(`${name}: uses eval()`);
    if (/new\s+Function\s*\(/.test(text)) problems.push(`${name}: uses new Function()`);
    if (/\bimportScripts\s*\(/.test(text)) problems.push(`${name}: uses importScripts()`);
    if (/<script[^>]+src=["']https?:/i.test(text)) problems.push(`${name}: loads a remote script`);
    if (/\/\/# sourceMappingURL=/.test(text)) problems.push(`${name}: ships a sourcemap reference`);
  }
  return problems;
}

function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).replaceAll("\\", "/")];
  });
}

function main() {
  if (!process.argv.includes("--no-build")) {
    execSync("pnpm --filter @jolt/extension run build", { cwd: root, stdio: "inherit" });
  }
  if (!existsSync(path.join(dist, "manifest.json"))) {
    console.error("apps/extension/dist/manifest.json not found. Build first.");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
  const names = listFiles(dist);
  const files = names.map((name) => ({ name, data: readFileSync(path.join(dist, name)) }));

  const problems = [
    ...checkManifest(manifest, (f) => names.includes(f)),
    ...checkCode(files.map((f) => ({ name: f.name, text: f.data.toString("utf8") }))),
  ];
  if (names.some((n) => /\.(map|ts|test\.js)$/.test(n))) problems.push("dist contains sourcemaps, TypeScript or test files");
  if (problems.length) {
    console.error("Not ready for the Chrome Web Store:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }

  const zip = createZip(files);
  const outDir = path.join(root, "release");
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `jolt-extension-${manifest.version}.zip`);
  writeFileSync(out, zip);
  const sha = createHash("sha256").update(zip).digest("hex");
  writeFileSync(`${out}.sha256`, `${sha}  ${path.basename(out)}\n`);
  console.log(`\nChecks passed. ${names.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
  console.log(`  ${path.relative(root, out)}\n  sha256 ${sha}`);
  console.log(`  version ${manifest.version}: upload this zip in the Chrome Web Store developer dashboard.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
