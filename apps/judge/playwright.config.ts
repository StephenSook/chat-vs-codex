import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./smoke",
  outputDir: "../../.local/judge-smoke",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4175",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 4175 --strictPort",
    url: "http://127.0.0.1:4175",
    timeout: 60000,
    reuseExistingServer: false,
  },
});
