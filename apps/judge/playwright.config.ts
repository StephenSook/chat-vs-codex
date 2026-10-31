import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

export const HOSTED_JUDGE_URL = "https://chat-vs-codex-judge.vercel.app";

export function judgeSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlaywrightTestConfig {
  const hosted = env.JUDGE_SMOKE_HOSTED === "1";
  return {
    testDir: "./smoke",
    outputDir: "../../.local/judge-smoke",
    timeout: 30000,
    workers: 1,
    reporter: "list",
    use: {
      baseURL: hosted ? HOSTED_JUDGE_URL : "http://127.0.0.1:4175",
      channel: env.CI ? "chromium" : "chrome",
      headless: true,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      viewport: { width: 1440, height: 1000 },
    },
    ...(!hosted
      ? {
          webServer: {
            command: "pnpm build && pnpm preview --port 4175 --strictPort",
            url: "http://127.0.0.1:4175",
            timeout: 60000,
            reuseExistingServer: false,
          },
        }
      : {}),
  };
}

export default defineConfig(judgeSmokeConfig());
