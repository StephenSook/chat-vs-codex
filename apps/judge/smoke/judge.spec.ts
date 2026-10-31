import { expect, test } from "@playwright/test";

test("committed evidence recomputes in a static preview at desktop and phone widths", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("h1")).toHaveText("CHAT / VS / CODEX");
  const evidence = await (
    await page.request.get("/evidence/index.json")
  ).json();
  await expect(page.locator(".round-card")).toHaveCount(evidence.rounds.length);
  await expect(
    page
      .locator(".round-card .eyebrow")
      .filter({ hasText: "TWITCH CHAT ROUND / TEST" }),
  ).toHaveCount(
    evidence.rounds.filter(
      (round: { receipt: { trigger?: string } }) =>
        round.receipt.trigger === "broadcaster-test",
    ).length,
  );
  await page.getByTestId("recompute-replay").click();
  await expect(page.getByTestId("proof-result")).toHaveAttribute(
    "data-state",
    "match",
  );
  await expect(page.getByTestId("proof-result")).toContainText("600 frames");
  await page.getByLabel("Validation replay frame").focus();
  await page.getByLabel("Validation replay frame").press("Home");
  await page.getByLabel("Validation replay frame").press("ArrowRight");
  await expect(page.locator(".mono")).toContainText("frame 2 of 600");
  await page
    .getByLabel("Round to re-simulate")
    .selectOption("65e06ea8-d2bd-4e40-9ec7-79f4318c2b02");
  await page.getByTestId("recompute-replay").click();
  await expect(page.getByTestId("proof-result")).toContainText(
    "legacy receipt",
  );
  await expect(page.getByTestId("proof-result")).toHaveAttribute(
    "data-state",
    "unavailable",
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({
      path: `../../.local/judge-smoke/judge-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  expect(
    requests.every(
      (url) =>
        url.startsWith("http://127.0.0.1:4175/") || url.startsWith("blob:"),
    ),
  ).toBe(true);
});
