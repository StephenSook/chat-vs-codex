import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { HOSTED_JUDGE_URL, judgeSmokeConfig } from "../playwright.config.js";

it("probes only the public hosted origin without starting a local replacement server", () => {
  const config = judgeSmokeConfig({ CI: "true", JUDGE_SMOKE_HOSTED: "1" });
  expect(config.use?.baseURL).toBe("https://chat-vs-codex-judge.vercel.app");
  expect(config.use?.baseURL).toBe(HOSTED_JUDGE_URL);
  expect(config.webServer).toBeUndefined();
  expect(config.use?.channel).toBe("chromium");
  expect(config.use?.trace).toBe("retain-on-failure");
  expect(judgeSmokeConfig({}).webServer).toMatchObject({
    command: "pnpm build && pnpm preview --port 4175 --strictPort",
  });
});

it("schedules an offset daily public smoke with manual dispatch and no secrets", () => {
  const workflow = readFileSync(
    new URL("../../../.github/workflows/judge-smoke.yml", import.meta.url),
    "utf8",
  );
  expect(workflow).toContain('cron: "19 15 * * *"');
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain('JUDGE_SMOKE_HOSTED: "1"');
  expect(workflow).toContain("pnpm judge:smoke");
  expect(workflow).toContain(
    "pnpm exec playwright install --with-deps chromium",
  );
  expect(workflow).toContain("contents: read");
  expect(workflow).not.toContain("secrets.");
});
