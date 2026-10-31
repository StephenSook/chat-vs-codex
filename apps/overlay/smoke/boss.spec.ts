import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { RoundAutopsy } from "../../../packages/round/src/contracts.js";

test("boss UI fixtures keep both crews and both patch excerpts readable at 720p", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.chatVsCodex));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const bus = window.chatVsCodex.events;
    bus.publish({
      type: "round.started",
      id: "ui-boss",
      number: 1,
      atMs: performance.now(),
    });
    bus.publish({ type: "boss.started", roundId: "ui-boss" });
    for (const model of ["terra", "sol"] as const)
      bus.publish({
        type: "codex.step",
        model,
        roundId: "ui-boss",
        id: `${model}-read`,
        step: { kind: "reading", path: "src/index.ts" },
        status: "done",
        attempt: 1,
        total: 1,
      });
  });
  await expect(page.locator("#boss-crews")).toBeVisible();
  for (const model of ["terra", "sol"])
    await expect(page.locator(`#boss-${model}-steps`)).toContainText(
      "Reading index.ts",
    );
  const crews = await page.locator("#boss-crews").boundingBox();
  expect(crews?.y).toBeGreaterThanOrEqual(0);
  expect((crews?.y ?? 720) + (crews?.height ?? 720)).toBeLessThanOrEqual(644);
  await expect(page.locator("#idle-cta")).toBeHidden();
  // UI fixture only. The added thread outcomes are not runtime measurements.
  const baseline = JSON.parse(
    readFileSync(
      new URL(
        "../../../docs/rounds/e14e58f2-dc2f-4f3d-b4bc-eac401989634.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { autopsy: RoundAutopsy };
  const card: RoundAutopsy = {
    ...baseline.autopsy,
    roundId: "ui-boss",
    boss: {
      winner: "terra",
      memory: {
        freeBytes: 2 * 1024 ** 3,
        rssBytes: 1024 ** 2,
        minimumFreeBytes: 1536 * 1024 ** 2,
        measuredAtMs: 0,
      },
      threads: ["terra", "sol"].map((model) => ({
        model: model as "terra" | "sol",
        status: "validated",
        failure: null,
        patch: baseline.autopsy.patch,
        timings: {
          threadStartedAtMs: 1,
          patchReadyAtMs: 2,
          validationStartedAtMs: 3,
          validationFinishedAtMs: 4,
        },
      })),
    },
  };
  await page.evaluate((autopsy) => {
    window.chatVsCodex.events.publish({
      type: "tests.green",
      roundId: "ui-boss",
    });
    window.chatVsCodex.events.publish({
      type: "round.autopsy",
      roundId: "ui-boss",
      autopsy,
    });
  }, card);
  await expect(page.locator("#boss-winner")).toContainText("TERRA");
  await expect(page.locator("#boss-loser-label")).toContainText("SOL");
  await expect(page.locator("#boss-loser-diff span")).toHaveCount(2);
  const geometry = await page.evaluate(() => {
    const card = document.getElementById("autopsy");
    const game = document.querySelector(".game-shell");
    const footer = document.querySelector(".bottom-line");
    const diff = document.getElementById("boss-loser-diff");
    const stage = document.getElementById("stage");
    if (!card || !game || !footer || !diff || !stage)
      throw new Error("Missing boss geometry");
    const a = card.getBoundingClientRect();
    return {
      offGame: a.left >= game.getBoundingClientRect().right,
      beforeFooter: a.bottom <= footer.getBoundingClientRect().top,
      fontSize:
        (Number.parseFloat(getComputedStyle(diff).fontSize) *
          stage.getBoundingClientRect().width) /
        1920,
    };
  });
  expect(geometry.offGame).toBe(true);
  expect(geometry.beforeFooter).toBe(true);
  expect(geometry.fontSize).toBeGreaterThanOrEqual(22);
  expect(errors).toEqual([]);
});
