import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "apps/server/src") },
  },
  test: {
    include: ["apps/server/src/**/*.test.ts", "apps/extension/src/**/*.test.ts", "bench/src/**/*.test.ts"],
    testTimeout: 15000,
  },
});
