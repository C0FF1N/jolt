import { defineConfig } from "tsup";

/**
 * dist/index.js is the DEV/test build: runtime packages stay external and resolve from node_modules.
 * (They are devDependencies because the published artifact is the single-file bundle from bundle.mjs,
 * which inlines them; tsup would otherwise inline devDependencies here too and break CommonJS requires.)
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  external: ["@modelcontextprotocol/sdk", "commander", "ws", "zod", "zod-to-json-schema"],
});
