// Checks that every relative link and image in the project's Markdown files points at a file that exists.
//   node scripts/check-links.mjs
// External (http/https/mailto) links and pure #anchors are not checked here.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".git", "baseline", "release", "results"]);

export function relativeLinks(markdown) {
  const out = [];
  // [text](target) and ![alt](target); also <img src="..."> in HTML-in-Markdown.
  for (const m of markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  for (const m of markdown.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) out.push(m[1]);
  return out
    .filter((t) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)) // skip http:, mailto:, anchors
    .map((t) => decodeURI(t.split("#")[0]))
    .filter(Boolean);
}

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : markdownFiles(path.join(dir, e.name));
    return e.name.endsWith(".md") ? [path.join(dir, e.name)] : [];
  });
}

function main() {
  const broken = [];
  for (const file of markdownFiles(root)) {
    for (const target of relativeLinks(readFileSync(file, "utf8"))) {
      // "../../releases/latest" style links are GitHub-relative; they only resolve on github.com.
      if (/^(\.\.\/)+(releases|issues|pulls|actions|security|wiki)\b/.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(file), target))) broken.push(`${path.relative(root, file)}: ${target}`);
    }
  }
  if (broken.length) {
    console.error("Broken relative links:\n" + broken.map((b) => `  - ${b}`).join("\n"));
    process.exit(1);
  }
  console.log("All relative Markdown links resolve.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
