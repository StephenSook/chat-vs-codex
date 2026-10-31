import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type {
  RoundEvent,
  SymptomReplay,
} from "../../../packages/round/src/contracts.js";

test("idle route starts itself and a streamer game key takes control immediately", async ({
  page,
}) => {
  await page.goto("/?mode=play");
  await page.waitForFunction(
    () => window.chatVsCodex?.snapshot().autopilot === true,
  );
  await expect(page.locator("#controls")).toHaveText("AUTOPILOT");
  await page.keyboard.down("ArrowLeft");
  await expect(page.locator("#controls")).not.toHaveText("AUTOPILOT");
  expect(
    await page.evaluate(() => window.chatVsCodex.snapshot().autopilot),
  ).toBe(false);
  await page.keyboard.up("ArrowLeft");
});

test("720p head start draws an honestly labelled recorded route and restores play afterward", async ({
  page,
  baseURL,
}) => {
  // Test-only SSE and short wire samples. No Twitch, round runner or model call.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const target = window as unknown as { fixtureSource: EventTarget };
    class FixtureSource extends EventTarget {
      constructor() {
        super();
        target.fixtureSource = this;
      }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FixtureSource });
  });
  const bundled = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../packages/sim/src/index.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
  });
  const code = bundled.outputFiles[0]?.text;
  if (!code) throw new Error("Missing smoke build");
  const digest = createHash("sha256").update(code).digest("hex");
  await page.route(`**/api/builds/${digest}.js`, (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: code }),
  );
  await page.setViewportSize({ width: 1280, height: 720 });
  const origin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;
  await page.goto(`/?bridge=${encodeURIComponent(origin)}`);
  await page.waitForFunction(
    () =>
      !!window.chatVsCodex &&
      !!(window as unknown as { fixtureSource?: EventTarget }).fixtureSource,
  );
  const replay: SymptomReplay = {
    fps: 60,
    buildDigest: digest,
    sourceDigest: "b".repeat(64),
    trackDigest: "c".repeat(64),
    firstDivergentFrame: 1,
    focus: "enemy",
    frames: [0, 1, 2].map((frame) => ({
      frame,
      x: 64 * 256,
      y: 296 * 256,
      vx: 0,
      vy: 0,
      alive: true,
      won: false,
      enemy: {
        x: (800 + frame) * 256,
        y: 232 * 256,
        vy: 0,
        direction: 1,
        turns: 0,
      },
    })),
  };
  const events: RoundEvent[] = [
    {
      type: "round.state",
      roundId: "fixture",
      phase: "preparing",
      headStartEndsAt: null,
      winner: null,
      reason: null,
    },
    {
      type: "game.build",
      roundId: "fixture",
      phase: "broken",
      buildId: digest,
      digest,
    },
    {
      type: "overlay",
      event: { type: "round.started", id: "fixture", number: 1, atMs: 0 },
    },
    {
      type: "overlay",
      event: { type: "round.symptom", roundId: "fixture", replay },
    },
    {
      type: "round.state",
      roundId: "fixture",
      phase: "head-start",
      headStartEndsAt: 15000,
      winner: null,
      reason: null,
    },
  ];
  await page.evaluate((events) => {
    const source = (window as unknown as { fixtureSource: EventTarget })
      .fixtureSource;
    for (const [index, event] of events.entries())
      source.dispatchEvent(
        new MessageEvent("round", {
          data: JSON.stringify({
            sequence: index + 1,
            serverTimeMs: 0,
            deliveryAtMs: 0,
            event,
          }),
        }),
      );
  }, events);
  await expect(page.locator("#run-status")).toHaveText("FAILING REPLAY · LOOP");
  expect(
    await page.evaluate(() => window.chatVsCodex.snapshot().camera.left),
  ).toBeLessThan(-1000);
  await page.screenshot({ path: "../../.local/symptom-720p.png" });
  await page.evaluate(() =>
    (
      window as unknown as { fixtureSource: EventTarget }
    ).fixtureSource.dispatchEvent(
      new MessageEvent("round", {
        data: JSON.stringify({
          sequence: 6,
          serverTimeMs: 0,
          event: {
            type: "round.state",
            roundId: "fixture",
            phase: "repairing",
            headStartEndsAt: null,
            winner: null,
            reason: null,
          },
        }),
      }),
    ),
  );
  await expect(page.locator("#run-status")).not.toHaveText(
    "FAILING REPLAY · LOOP",
  );
  expect(errors).toEqual([]);
});
