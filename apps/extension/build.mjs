import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const common = { bundle: true, target: "chrome120", sourcemap: false, minify: false, logLevel: "info" };
await build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" });
await build({ ...common, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js", format: "iife" });
for (const f of ["manifest.json", "popup.html", "popup.css"]) cpSync(f, `dist/${f}`);
if (!existsSync("icons")) throw new Error("icons/ is missing; run: node ../../scripts/make-icons.mjs");
cpSync("icons", "dist/icons", { recursive: true });
console.log("Extension built into apps/extension/dist (load this folder via chrome://extensions > Load unpacked)");
