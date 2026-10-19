// Fails when the release version is not the same everywhere (extension manifest, the three package.json
// files) or does not match the git tag being released.
//
//   node scripts/check-versions.mjs [v1.2.3]      (the tag argument is optional; CI passes $GITHUB_REF_NAME)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = ["package.json", "apps/server/package.json", "apps/extension/package.json", "apps/extension/manifest.json"];

/** @param {Record<string, string>} versions file -> version; @param {string | undefined} tag e.g. "v1.2.3" */
export function checkVersions(versions, tag) {
  const problems = [];
  const distinct = [...new Set(Object.values(versions))];
  if (distinct.length > 1) {
    problems.push("versions differ: " + Object.entries(versions).map(([f, v]) => `${f}=${v}`).join(", "));
  }
  if (tag) {
    const want = tag.replace(/^v/, "");
    for (const [file, v] of Object.entries(versions)) if (v !== want) problems.push(`${file} is ${v} but the tag is ${tag}`);
  }
  return problems;
}

function main() {
  const versions = Object.fromEntries(SOURCES.map((f) => [f, JSON.parse(readFileSync(path.join(root, f), "utf8")).version]));
  const tag = process.argv[2] && /^v?\d/.test(process.argv[2]) ? process.argv[2] : undefined;
  const problems = checkVersions(versions, tag);
  if (problems.length) {
    console.error("Version check failed:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`All versions agree: ${Object.values(versions)[0]}${tag ? ` (tag ${tag})` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
