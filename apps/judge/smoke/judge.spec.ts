import { expect, test } from "@playwright/test";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import { deriveSeason } from "../../../packages/round/src/season.js";
import { isEarlierTestRound, type JudgeEvidence } from "../src/evidence.js";
import { RULE } from "../src/framing.js";
import { benchmarkRaceLine, featuredRound } from "../src/hero.js";
import { RACE_RULE, raceSummary } from "../src/race-summary.js";
import { summarizeSecondGameTrials } from "../src/second-game.js";

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
  await expect(page.locator("header .lede")).toHaveText(RULE);
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
  const evidence: JudgeEvidence = await (
    await page.request.get("/evidence/index.json")
  ).json();
  const featuredId = featuredRound(evidence.rounds);
  expect(featuredId).toBeTruthy();
  const featured = page.getByTestId("featured-replay");
  await expect(featured).toHaveAttribute("data-round-id", featuredId ?? "");
  await expect(featured.getByTestId("comparison-view")).toHaveAttribute(
    "data-state",
    "match",
  );
  await expect(
    featured.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator("header")
      .evaluate((header) => header.nextElementSibling?.id),
  ).toBe("watch");
  await featured.getByRole("button", { name: "Pause", exact: true }).click();
  const benchmark = summarizeResults(
    parseResultsJsonl(
      await (await page.request.get(evidence.benchmark.path)).text(),
    ),
    { batchId: evidence.benchmark.batchId },
  );
  await expect(page.getByTestId("benchmark-race-line")).toHaveText(
    benchmarkRaceLine(benchmark),
  );
  await expect(page.locator("#numbers .badge")).toHaveCount(0);
  await expect(page.locator("#rounds .race-rule")).toHaveText(RACE_RULE);
  await expect(page.locator("#rounds .race-rule")).toBeVisible();
  for (const { receipt } of evidence.rounds) {
    const card = page.locator(`[data-round-id="${receipt.roundId}"]`);
    const race = card.getByTestId("race-summary");
    const recorded = raceSummary(receipt);
    await expect(race).toContainText(`Winner ${recorded.winner}`);
    await expect(race).toContainText(`First correct ${recorded.firstCorrect}`);
    await expect(race).toContainText(`Head start ${recorded.headStart}`);
    await expect(card.locator(".round-result > .round-time")).toHaveCount(1);
    await expect(card.locator(".round-result > .race-summary")).toHaveCount(1);
    if (!isEarlierTestRound(receipt)) await expect(race).toBeVisible();
  }
  const season = deriveSeason(
    evidence.rounds.map(
      (round: { receipt: Parameters<typeof deriveSeason>[0][number] }) =>
        round.receipt,
    ),
  );
  const scoreboard = page.getByTestId("season-scoreboard");
  if (season.viewers.rounds > 0) {
    await expect(scoreboard).toContainText(
      `CHAT ${season.viewers.chatWins} : CODEX ${season.viewers.codexWins}`,
    );
    await expect(scoreboard).toContainText(
      `${season.viewers.rounds} viewer rounds`,
    );
    await expect(scoreboard).toContainText(
      `${season.tests.rounds} test rounds kept separate`,
    );
  } else await expect(scoreboard).toHaveCount(0);
  if (evidence.secondGame) {
    const second = page.getByTestId("second-game-card");
    await expect(second).toContainText("Breakout");
    await expect(second.locator(".big-number")).toHaveText(
      `${evidence.secondGame.pool.accepted} / ${evidence.secondGame.pool.enumerated}`,
    );
    if (!evidence.secondGame.benchmark)
      await expect(second).toContainText("Runtime benchmark pending.");
    else {
      const results = await page.request.get(
        evidence.secondGame.benchmark.path,
      );
      expect(results.ok()).toBe(true);
      const summary = summarizeSecondGameTrials(
        await results.text(),
        evidence.secondGame.pool.sourceDigest,
      );
      expect(summary.models.length).toBeGreaterThan(0);
      for (const model of summary.models) {
        const metrics = second.locator(
          `[data-testid="second-game-metrics"][data-model="${model.model}"]`,
        );
        await expect(metrics).toContainText(
          `${model.overall.green}/${model.overall.trials} fixed`,
        );
        await expect(metrics).toContainText(
          `${((model.overall.medianGreenMs ?? 0) / 1000).toFixed(2)} s`,
        );
        await expect(second.getByTestId("second-game-sample")).toBeVisible();
        await expect(second.getByTestId("second-game-sample")).toContainText(
          `n=${model.overall.trials};`,
        );
        if (model.families.every((family) => family.metrics.trials === 1))
          await expect(second.getByTestId("second-game-sample")).toContainText(
            "one trial per site",
          );
      }
    }
    await second
      .getByText("Pool, replay gates + commands", { exact: true })
      .click();
    await expect(
      second.getByText("pnpm breakout:bench --run", { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("link", { name: "$hotfix-ready skill" }),
    ).toHaveAttribute("href", /\.agents\/skills\/hotfix-ready\/SKILL\.md$/);
    await second
      .getByText("Pool, replay gates + commands", { exact: true })
      .click();
  }
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
  const comparison = page.getByTestId("comparison-view");
  for (const id of [
    "c81bdc19-304f-47d5-800e-5098b9a1b5e2",
    "c37736fc-52d2-4ca0-9eee-dae78a5eff7b",
  ]) {
    const round = evidence.rounds.find((row) => row.receipt.roundId === id);
    expect(round?.comparison?.status).toBe("available");
    if (round?.comparison?.status !== "available")
      throw new Error("Expected committed comparison fixture");
    await page.getByLabel("Round to re-simulate").selectOption(id);
    await page.getByTestId("recompute-replay").click();
    await expect(page.getByTestId("proof-result")).toContainText("600 frames");
    await expect(comparison).toHaveAttribute("data-state", "match");
    await expect(comparison.getByText("BROKEN", { exact: true })).toBeVisible();
    await expect(comparison.getByText("FIXED", { exact: true })).toBeVisible();
    const original = page.getByTestId("broken-view");
    const repaired = page.getByTestId("fixed-view");
    const frame = Number(await original.getAttribute("data-frame"));
    await expect(repaired).toHaveAttribute("data-frame", String(frame));
    for (const axis of ["x", "y"])
      expect(await original.getAttribute(`data-camera-${axis}`)).toBe(
        await repaired.getAttribute(`data-camera-${axis}`),
      );
    expect(await original.getAttribute("data-hash")).not.toBe(
      await repaired.getAttribute("data-hash"),
    );
    await expect(original).toHaveAttribute(
      "data-focus",
      id.startsWith("c377") ? "enemy" : "player",
    );
    expect(frame).toBe(round.comparison.display.visibleFrame);
    const brokenResponse = await page.request.get(
      round.comparison.brokenArtifactPath,
    );
    expect(brokenResponse.ok()).toBe(true);
    const actualHash = await page.evaluate(
      async ({ code, track, frame }) => {
        const url = URL.createObjectURL(
          new Blob([code], { type: "text/javascript" }),
        );
        try {
          const game = await import(/* @vite-ignore */ url);
          let state = game.createState(track.seed);
          for (const input of track.inputs.slice(0, frame))
            state = game.step(state, input);
          return game.hashState(state) as string;
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      {
        code: await brokenResponse.text(),
        track: round.comparison.display.track,
        frame,
      },
    );
    await expect(original).toHaveAttribute("data-hash", actualHash);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
      await page.screenshot({
        path: `../../.local/judge-smoke/comparison-${id.slice(0, 8)}-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await comparison.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(async () => Number(await original.getAttribute("data-frame")))
      .toBeGreaterThan(frame);
    await comparison
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await page.getByLabel("Comparison replay frame").focus();
    await page.getByLabel("Comparison replay frame").press("Home");
    await expect(original).toHaveAttribute("data-frame", "1");
    await expect(repaired).toHaveAttribute("data-frame", "1");
  }
  // A card must not relabel an in-flight replay while its selector is disabled.
  const pendingRound = evidence.rounds.find((row) =>
    row.receipt.roundId.startsWith("c81bdc19"),
  );
  if (pendingRound?.comparison?.status !== "available")
    throw new Error("Missing pending replay fixture");
  let release!: () => void;
  let entered = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const artifactUrl = new URL(
    pendingRound.comparison.brokenArtifactPath,
    page.url(),
  ).href;
  await page.route(artifactUrl, async (route) => {
    entered = true;
    await blocked;
    await route.continue();
  });
  try {
    await page
      .getByLabel("Round to re-simulate")
      .selectOption(pendingRound.receipt.roundId);
    await page.getByTestId("recompute-replay").click();
    await expect.poll(() => entered).toBe(true);
    await page
      .locator('[data-round-id="c37736fc-52d2-4ca0-9eee-dae78a5eff7b"]')
      .getByRole("button", { name: "Recompute this round" })
      .click();
    await expect(page.getByLabel("Round to re-simulate")).toHaveValue(
      pendingRound.receipt.roundId,
    );
  } finally {
    release();
  }
  await expect(comparison).toHaveAttribute("data-state", "match");
  await page.unroute(artifactUrl);
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
  await expect(comparison).toHaveAttribute("data-state", "unavailable");
  await expect(page.getByTestId("broken-view")).toBeHidden();
  await expect(page.getByTestId("fixed-view")).toBeHidden();
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

test("phone hero has one VS, one scrolling nav row and readable labels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(
    page.getByTestId("featured-replay").getByTestId("comparison-view"),
  ).toHaveAttribute("data-state", "match");
  await expect(page.locator(".brand-vs")).toHaveCount(1);
  await expect(page.locator("nav")).not.toContainText(/\bvs\b/i);
  const nav = await page.locator("nav").evaluate((node) => {
    const rows = [...node.querySelectorAll("a")].map((link) => {
      const box = link.getBoundingClientRect();
      return box.y + box.height / 2;
    });
    return {
      rows,
      overflow: getComputedStyle(node).overflowX,
      height: node.getBoundingClientRect().height,
    };
  });
  expect(Math.max(...nav.rows) - Math.min(...nav.rows)).toBeLessThan(1);
  expect(nav.overflow).toBe("auto");
  expect(nav.height).toBeLessThan(70);
  const labels = await page
    .locator(
      ".eyebrow, .stat span, .badge, .race-summary span, .comparison-panes figcaption, nav a, .brand-vs",
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: node.textContent,
        size: Number.parseFloat(getComputedStyle(node).fontSize),
      })),
    );
  expect(labels.length).toBeGreaterThan(10);
  expect(labels.filter((label) => label.size < 14)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: "../../.local/judge-smoke/judge-phone-390x844.png",
    fullPage: false,
  });
});

test("round proof fragments open the committed receipt and reject unpublished ids", async ({
  page,
}) => {
  const first = "8a34be05-c8b6-45b1-b8ee-a04735d68cc4";
  const boss = "d4c4ec5f-b7e8-420e-bb16-91df94677f09";
  await page.goto(`/#r=${first}`);
  const featured = page.getByTestId("featured-replay");
  const comparison = featured.getByTestId("comparison-view");
  await expect(featured).toHaveAttribute("data-round-id", first);
  await expect(comparison).toHaveAttribute("data-state", "match");
  await expect(featured).toContainText("TWITCH CHAT ROUND / TEST");
  await page.evaluate((id) => {
    location.hash = `r=${id}`;
  }, boss);
  await expect(featured).toHaveAttribute("data-round-id", boss);
  await expect(comparison).toHaveAttribute("data-state", "unavailable");
  await expect(featured).toContainText(
    "The original and repaired installations are not bound by this receipt.",
  );
  await expect(featured).toContainText("TWITCH BOSS ROUND / STREAMER START");
  await page.evaluate(() => {
    location.hash = "r=00000000-0000-4000-8000-000000000000";
  });
  await expect(comparison).toHaveAttribute("data-state", "unavailable");
  await expect(featured).toContainText("Round not published yet.");
  await expect(featured.getByTestId("broken-view")).toBeHidden();
  await expect(featured).not.toHaveAttribute("data-round-id", boss);
});

test("the latest proof fragment wins when navigation changes during verification", async ({
  page,
}) => {
  await page.goto("/");
  const featured = page.getByTestId("featured-replay");
  const comparison = featured.getByTestId("comparison-view");
  await expect(comparison).toHaveAttribute("data-state", "match");
  const evidence = (await (
    await page.request.get("/evidence/index.json")
  ).json()) as JudgeEvidence;
  const slow = evidence.rounds.find((row) =>
    row.receipt.roundId.startsWith("c81bdc19"),
  );
  if (slow?.comparison?.status !== "available")
    throw new Error("Missing exact fixture artifact");
  let release!: () => void;
  let entered = false;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const artifact = new URL(slow.comparison.brokenArtifactPath, page.url()).href;
  await page.route(artifact, async (route) => {
    entered = true;
    await blocked;
    await route.continue();
  });
  const viewer = "ac8b50c7-1012-4f20-af7e-10dd718b9f1c";
  try {
    await page.evaluate((id) => {
      location.hash = `r=${id}`;
    }, slow.receipt.roundId);
    await expect.poll(() => entered).toBe(true);
    await page.evaluate((id) => {
      location.hash = `r=${id}`;
    }, viewer);
  } finally {
    release();
  }
  await expect(featured).toHaveAttribute("data-round-id", viewer);
  await expect(comparison).toHaveAttribute("data-state", "match");
  await expect(page.getByLabel("Round to re-simulate")).toHaveValue(viewer);
  await page.unroute(artifact);
});
