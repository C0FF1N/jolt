import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
const common = { bundle: true, target: "chrome116", sourcemap: false, minify: false, logLevel: "info" };
await build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" });
await build({ ...common, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js", format: "iife" });
cpSync("manifest.json", "dist/manifest.json");
cpSync("popup.html", "dist/popup.html");
console.log("Extension built into apps/extension/dist (load this folder via chrome://extensions > Load unpacked)");
