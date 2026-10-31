import { expect, test } from "@playwright/test";

test("committed evidence recomputes in a static preview at desktop and phone widths", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const origin = new URL(baseURL ?? "http://127.0.0.1:4175").origin;
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("h1")).toHaveAccessibleName("CHAT vs CODEX");
  const vs = page.locator(".brand-vs");
  await expect(vs).toBeVisible();
  const vsSize = await vs.boundingBox();
  expect(vsSize?.width).toBeGreaterThan(vsSize?.height ?? 0);
  await expect(vs).toHaveCSS("flex-shrink", "0");
  await expect(page.locator(".brand-chat")).toHaveCSS(
    "background-color",
    "rgb(247, 145, 78)",
  );
  await expect(page.locator(".brand-chat")).toHaveCSS(
    "color",
    "rgb(31, 29, 27)",
  );
  await expect(page.locator(".brand-codex")).toHaveCSS(
    "background-color",
    "rgb(4, 119, 189)",
  );
  await expect(page.locator(".brand-codex")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".brand-mark path")).toHaveCount(2);
  const faviconPath = await page
    .locator('link[rel="icon"]')
    .getAttribute("href");
  expect(faviconPath).toBeTruthy();
  const favicon = await page.request.get(faviconPath ?? "/favicon.svg");
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()["content-type"]).toContain("image/svg+xml");
  expect(await favicon.text()).toContain("#F7914E");
  await expect(
    page.getByText("Earlier test rounds", { exact: true }),
  ).toBeVisible();
  const earlier = page.locator("details.earlier-tests");
  await expect(earlier).not.toHaveAttribute("open", "");
  await expect(earlier.locator(".round-card")).toHaveCount(1);
  await expect(earlier.locator(".round-card")).toBeHidden();
  await earlier.locator(":scope > summary").click();
  await expect(earlier.locator(".round-card")).toBeVisible();
  await earlier.locator(":scope > summary").click();
  const evidence = await (
    await page.request.get("/evidence/index.json")
  ).json();
  await expect(page.locator(".round-card")).toHaveCount(evidence.rounds.length);
  await page.getByText("Session + commit graph", { exact: true }).click();
  await expect(
    page.getByText(`Main session ${evidence.sessionId}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`git rev-list --count ${evidence.commit}`, { exact: true }),
  ).toBeVisible();
  await expect(page.locator("#build .stat strong").first()).toHaveText(
    String(evidence.commitCount),
  );
  await page.getByText("Session + commit graph", { exact: true }).click();
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
      (url) => url.startsWith(`${origin}/`) || url.startsWith("blob:"),
    ),
  ).toBe(true);
});
