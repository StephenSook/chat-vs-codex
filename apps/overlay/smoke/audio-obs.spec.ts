import { expect, test } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});
test("plays a fixture SFX without any click and keeps sound controls small", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as {
      mediaPlays: { url: string; volume: number }[];
    };
    state.mediaPlays = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      return original.call(this).then(() => {
        state.mediaPlays.push({ url: this.src, volume: this.volume });
      });
    };
  });
  await page.goto("/?mode=play&sound=on");
  await page.waitForFunction(() => !!window.chatVsCodex);
  const speaker = page.getByRole("button", { name: "MUTE", exact: true });
  await expect(speaker).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Sound volume" })).toHaveValue(
    "15",
  );
  await page.evaluate(() => {
    // Test-only contract fixture. No round server, Twitch or model is involved.
    window.chatVsCodex.events.publish({
      type: "round.started",
      id: "obs-audio-fixture",
      number: 1,
      atMs: performance.now(),
    });
    window.chatVsCodex.events.publish({
      type: "tests.green",
      roundId: "obs-audio-fixture",
    });
  });
  await page.waitForFunction(() =>
    (window as unknown as { mediaPlays: { url: string }[] }).mediaPlays.some(
      (clip) => clip.url.endsWith("/audio/codex-fix.wav"),
    ),
  );
  const played = await page.evaluate(
    () =>
      (window as unknown as { mediaPlays: { url: string; volume: number }[] })
        .mediaPlays,
  );
  expect(played).toHaveLength(1);
  expect(played[0]?.volume).toBe(0.15);
  expect((await speaker.textContent())?.trim()).toBe("");
  const bounds = await speaker.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(30);
  expect(bounds?.height).toBeLessThanOrEqual(28);
  await speaker.click();
  await expect(
    page.getByRole("button", { name: "UNMUTE", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});
