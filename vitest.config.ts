import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "games/**/*.test.ts",
    ],
    // The 8 GB streaming Mac must not copy two isolated integration workspaces
    // at once. Keep deadlines unchanged; Ubuntu CI retains two workers.
    maxWorkers: process.platform === "darwin" ? 1 : 2,
    testTimeout: 15000,
  },
});
