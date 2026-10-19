// Produces dist/jolt-server.mjs: the whole server (and its npm dependencies) in ONE file,
// so a release only needs Node >= 22 and no node_modules. This file is what the npm package ships.
//
// Because third-party packages are inlined, their licenses must travel with the bundle: this script also
// writes dist/THIRD_PARTY_NOTICES.txt (name, version, license and full license text of every bundled package)
// and copies the repo's NOTICE next to the package.
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const outfile = "dist/jolt-server.mjs";
const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  metafile: true,
  // Some bundled dependencies (ws, commander) use require(); provide it in ESM.
  banner: {
    js: [
      "// Jolt server. Derived from the Browser MCP server (Apache-2.0) and modified by C0FF1N; see NOTICE.",
      "// Bundled third-party packages and their licenses: THIRD_PARTY_NOTICES.txt.",
      'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    ].join("\n"),
  },
  logLevel: "info",
});
chmodSync(outfile, 0o755);

/** "../../node_modules/.pnpm/ws@8/node_modules/ws/lib/x.js" -> directory of the package "ws" (or null). */
function packageRoot(inputPath) {
  const parts = inputPath.split("/");
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length) return null;
  const len = parts[i + 1].startsWith("@") ? 2 : 1;
  return parts.slice(0, i + 1 + len).join("/");
}

const roots = new Set(Object.keys(result.metafile.inputs).map(packageRoot).filter(Boolean));
const packages = [...roots]
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) }))
  .sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));

const rule = "=".repeat(78);
const sections = [];
const missing = [];
for (const { dir, pkg } of packages) {
  const licenseFiles = readdirSync(dir).filter((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  if (licenseFiles.length === 0) missing.push(`${pkg.name}@${pkg.version}`);
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "";
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "see package";
  const text = licenseFiles.length
    ? licenseFiles.map((f) => readFileSync(path.join(dir, f), "utf8").trim()).join("\n\n")
    : `(no license file in the package; declared license: ${license})`;
  sections.push(`${rule}\n${pkg.name}@${pkg.version}  |  ${license}${repo ? `  |  ${repo}` : ""}\n${rule}\n\n${text}\n`);
}
writeFileSync(
  "dist/THIRD_PARTY_NOTICES.txt",
  `Third-party software bundled into jolt-server.mjs (${packages.length} packages)\n\n` +
    `Jolt itself is Apache-2.0 (see LICENSE and NOTICE). The packages below are included in the bundle under\n` +
    `their own licenses, reproduced here as those licenses require.\n\n${sections.join("\n")}`,
);
console.log(`dist/THIRD_PARTY_NOTICES.txt: ${packages.length} packages${missing.length ? `, NO LICENSE FILE for: ${missing.join(", ")}` : ""}`);

// Apache-2.0 section 4(d): the NOTICE must travel with the distributed work (LICENSE is committed here).
if (!existsSync("../../NOTICE")) throw new Error("../../NOTICE is missing");
cpSync("../../NOTICE", "NOTICE");
