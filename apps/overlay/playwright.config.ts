import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./smoke",
  outputDir: "../../.local/overlay-smoke",
  timeout: 30000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.OVERLAY_URL ?? "http://127.0.0.1:4173",
    channel: "chrome",
    headless: true,
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
});
