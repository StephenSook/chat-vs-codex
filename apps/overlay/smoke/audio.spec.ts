import { expect, test } from "@playwright/test";

test("original audio assets load and focused sound controls keep their keyboard input", async ({
  page,
}) => {
  await page.goto("/?mode=play");
  await page.waitForFunction(
    () => window.chatVsCodex?.snapshot().mode === "play",
  );
  for (const name of ["bug-in", "chat-correct", "codex-fix", "codex-fail"]) {
    const response = await page.request.get(`/audio/${name}.wav`);
    expect(response.ok()).toBe(true);
    expect((await response.body()).subarray(0, 4).toString("ascii")).toBe(
      "RIFF",
    );
  }
  const volume = page.getByRole("slider", { name: "Sound volume" });
  await expect(volume).toHaveValue("15");
  await volume.focus();
  await page.keyboard.press("ArrowRight");
  await expect(volume).toHaveValue("16");
  await page.getByRole("button", { name: "ENABLE SOUND" }).click();
  await expect(
    page.getByRole("button", { name: "MUTE", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "MUTE", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "UNMUTE", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

test.describe("OBS autoplay policy", () => {
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
    await expect(
      page.getByRole("slider", { name: "Sound volume" }),
    ).toHaveValue("15");
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
});
