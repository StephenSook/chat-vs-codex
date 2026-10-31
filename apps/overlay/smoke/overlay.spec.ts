import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runTrack } from "@chat-vs-codex/replay";
import { hashState } from "@chat-vs-codex/sim";
import { expect, test } from "@playwright/test";
import type { OverlayEvent } from "../src/events.js";
import { CLEAN_TRACK } from "../src/simulation.js";

const stillDir = resolve(
  process.env.OVERLAY_STILLS ?? "../../.local/overlay-stills",
);

test("real sim renders, reproduces hashes, and keeps HUD readable at both sizes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => window.chatVsCodex?.snapshot().frame > 60);
  await page.evaluate(() => document.fonts.ready);
  const actual = await page.evaluate(() => window.chatVsCodex.snapshot());
  expect(actual.mode).toBe("replay");
  expect(actual.filtersEnabled).toBe(true);
  expect(actual.corruption.treatment).toBe("none");
  expect((actual.camera.player.height * 720) / 1080).toBeGreaterThanOrEqual(32);
  const favicon = await page.request.get("/favicon.svg");
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
  const expected = runTrack({
    ...CLEAN_TRACK,
    inputs: CLEAN_TRACK.inputs.slice(0, actual.frame),
  });
  expect(actual.hash).toBe(hashState(expected.final));
  await expect(page.locator("#steps")).toHaveText("○ Waiting for Codex");
  await expect(page.locator("#countdown")).toBeHidden();
  await expect(page.locator("#attempt")).toBeHidden();
  await mkdir(stillDir, { recursive: true });

  for (const [width, height] of [
    [1920, 1080],
    [1280, 720],
  ] as const) {
    await page.setViewportSize({ width, height });
    // Numeric stage scaling includes OBS's older embedded Chromium.
    const geometry = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>("#stage");
      if (!stage) throw new Error("Missing stage");
      const rect = stage.getBoundingClientRect();
      const scale = rect.width / 1920;
      const required = [
        "#bug-name",
        "#steps li",
        "#playback-label",
        "#run-status",
      ];
      return {
        width: rect.width,
        height: rect.height,
        minText: Math.min(
          ...required.map((selector) => {
            const item = document.querySelector(selector);
            if (!item) throw new Error(`Missing ${selector}`);
            return Number.parseFloat(getComputedStyle(item).fontSize) * scale;
          }),
        ),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.width).toBeCloseTo(width);
    expect(geometry.height).toBeCloseTo(height);
    expect(geometry.minText).toBeGreaterThanOrEqual(height === 720 ? 22 : 32);
    expect(geometry.overflow).toBe(false);
    await page.screenshot({ path: resolve(stillDir, `overlay-${height}.png`) });
  }
  expect(errors).toEqual([]);
});

test("event fixtures exercise countdown, retry vocabulary, and corruption clearing", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.chatVsCodex));
  const publish = (events: OverlayEvent[]) =>
    page.evaluate((messages) => {
      for (const message of messages)
        window.chatVsCodex.events.publish(message);
    }, events);
  // These are UI test fixtures, never recorded round evidence or fake SDK output.
  await page.evaluate(() =>
    window.chatVsCodex.events.publish({
      type: "round.started",
      id: "ui-test",
      number: 1,
      atMs: performance.now(),
    }),
  );
  await publish([
    { type: "bug.active", roundId: "ui-test", intensity: 0.7 },
    {
      type: "codex.step",
      roundId: "ui-test",
      id: "read",
      step: { kind: "reading", path: "src/index.ts" },
      status: "done",
      attempt: 1,
      total: 3,
    },
    {
      type: "codex.step",
      roundId: "ui-test",
      id: "replay",
      step: { kind: "replay" },
      status: "done",
      attempt: 1,
      total: 3,
    },
    {
      type: "codex.step",
      roundId: "ui-test",
      id: "patch",
      step: { kind: "patch", added: 2, removed: 1 },
      status: "done",
      attempt: 1,
      total: 3,
    },
    {
      type: "codex.step",
      roundId: "ui-test",
      id: "tests",
      step: { kind: "tests" },
      status: "failed",
      attempt: 1,
      total: 3,
    },
  ]);
  await expect(page.locator("#countdown")).toBeVisible();
  await expect(page.locator("#attempt")).toHaveText("Attempt 1/3");
  await expect(page.locator("#steps li")).toHaveCount(4);
  await expect(page.locator("#steps")).toContainText("[FAILED]");
  await expect(page.locator("#bug-name")).toHaveText("???");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator("#game")).toHaveAttribute(
    "data-corruption",
    "animated",
  );
  const corruption = await page.evaluate(
    () => window.chatVsCodex.snapshot().corruption,
  );
  expect(corruption.rgbOffset).toBeCloseTo(6.3);
  const docked = await page.evaluate(() => {
    const game = document.querySelector(".game-shell")?.getBoundingClientRect();
    if (!game) throw new Error("Missing game");
    return ["#bug-ticket", "#countdown", ".ticker"].every((selector) => {
      const panel = document.querySelector(selector)?.getBoundingClientRect();
      if (!panel) throw new Error(`Missing ${selector}`);
      return (
        panel.right <= game.left ||
        panel.left >= game.right ||
        panel.bottom <= game.top ||
        panel.top >= game.bottom
      );
    });
  });
  expect(docked).toBe(true);
  await page.screenshot({ path: resolve(stillDir, "overlay-720-ui-test.png") });
  await publish([{ type: "tests.green", roundId: "ui-test" }]);
  await expect(page.locator("#bug-name")).toHaveText("Fixed");
  await expect(page.locator("#game")).toHaveAttribute("data-status", "fixed");
  await expect(page.locator("#countdown")).toBeHidden();
  await expect(page.locator("#game")).toHaveAttribute(
    "data-corruption",
    "none",
  );
});

test("keyboard input changes the actual sim and reduced motion disables filters", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mode=play");
  await page.waitForFunction(() => Boolean(window.chatVsCodex));
  expect(
    await page.evaluate(() => window.chatVsCodex.snapshot().filtersEnabled),
  ).toBe(false);
  await page.evaluate(() => {
    window.chatVsCodex.events.publish({
      type: "round.started",
      id: "reduced",
      number: 1,
      atMs: performance.now(),
    });
    window.chatVsCodex.events.publish({
      type: "bug.active",
      roundId: "reduced",
      intensity: 0.7,
    });
  });
  await expect(page.locator("#game")).toHaveAttribute(
    "data-corruption",
    "static",
  );
  expect(
    await page.evaluate(
      () => window.chatVsCodex.snapshot().corruption.rgbOffset,
    ),
  ).toBe(0);
  await expect(page.locator("#playback-label")).toHaveText("FREE PLAY");
  const before = await page.evaluate(() => window.chatVsCodex.snapshot());
  await page.keyboard.down("ArrowRight");
  await page.waitForFunction(
    (frame) => window.chatVsCodex.snapshot().frame > frame + 15,
    before.frame,
  );
  await page.keyboard.up("ArrowRight");
  const after = await page.evaluate(() => window.chatVsCodex.snapshot());
  expect(after.hash).not.toBe(before.hash);
  await page.keyboard.press("KeyR");
  expect(
    (await page.evaluate(() => window.chatVsCodex.snapshot())).frame,
  ).toBeLessThan(after.frame);
});

test("overview keeps the entire level available without claiming a ghost replay", async ({
  page,
}) => {
  await page.goto("/?camera=overview");
  await page.waitForFunction(() => Boolean(window.chatVsCodex));
  const snapshot = await page.evaluate(() => window.chatVsCodex.snapshot());
  expect(snapshot.camera.zoom).toBe(1200 / 1280);
  expect(snapshot.camera.left).toBeGreaterThanOrEqual(0);
  expect(snapshot.camera.top).toBeGreaterThanOrEqual(0);
  await expect(page.locator("#playback-label")).toHaveText("CLEAN REPLAY");
});
