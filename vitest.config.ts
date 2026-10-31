import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 15000,
  },
});
