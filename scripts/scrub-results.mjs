// Makes raw benchmark JSON portable: stores the server entry path relative to the repo root.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("bench/results");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
  const p = path.join(dir, f);
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (typeof j.entry !== "string") continue;
  const norm = j.entry.replaceAll("\\", "/");
  const m = norm.match(/\/(baseline\/.*|apps\/server\/.*)$/);
  if (m && norm !== m[1]) {
    j.entry = m[1];
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    console.log(f, "->", j.entry);
  }
}
