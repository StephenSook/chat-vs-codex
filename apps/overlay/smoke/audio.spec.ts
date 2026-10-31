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
