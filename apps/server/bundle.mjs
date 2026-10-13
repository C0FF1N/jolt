// Produces dist/browsermcp-turbo.mjs: the whole server (and its npm dependencies) in ONE file,
// so a release only needs Node >= 22 and no node_modules.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

const outfile = "dist/browsermcp-turbo.mjs";
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  // Some bundled dependencies (ws, commander) use require(); provide it in ESM.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "info",
});
chmodSync(outfile, 0o755);
