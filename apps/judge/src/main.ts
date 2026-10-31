import {
  type GroupSummary,
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import type { ValidatedReplayFrame } from "../../../packages/bench/src/validated-replay.js";
import {
  greenSplit,
  isEarlierTestRound,
  type JudgeEvidence,
  roundInputLabel,
  roundLabel,
  seconds,
} from "./evidence.js";
import {
  type GameModule,
  loadVerifiedGame,
  proofAvailability,
  replayProof,
  sha256,
} from "./proof.js";
import "./style.css";
import { RULE } from "./framing.js";
import { summarizeSecondGameTrials } from "./second-game.js";

const REPO = "https://github.com/StephenSook/chat-vs-codex";
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(text: string, href: string): HTMLAnchorElement {
  const node = element("a", text);
  node.href = href;
  return node;
}
function details(summary: string, ...children: Node[]): HTMLDetailsElement {
  const node = element("details");
  node.append(element("summary", summary), ...children);
  return node;
}
function stat(label: string, value: string): HTMLElement {
  const node = element("div", undefined, "stat");
  node.append(element("span", label), element("strong", value));
  return node;
}
function metricRow(label: string, metrics: GroupSummary): HTMLTableRowElement {
  const row = element("tr");
  for (const value of [
    label,
    `${metrics.green}/${metrics.trials}`,
    `${((metrics.fixRate ?? 0) * 100).toFixed(1)}%`,
    seconds(metrics.medianGreenMs),
    seconds(metrics.p90GreenMs),
    metrics.medianGreen95CiMs?.map(seconds).join(" to ") ?? "unavailable",
    `${metrics.exactReverts}`,
    `${metrics.greensBeforeHeadStart}`,
    metrics.gate,
  ])
    row.append(element("td", value));
  return row;
}
function json(value: unknown): HTMLPreElement {
  return element("pre", JSON.stringify(value, null, 2));
}
function section(id: string, eyebrow: string, title: string): HTMLElement {
  const node = element("section");
  node.id = id;
  node.append(element("p", eyebrow, "eyebrow"), element("h2", title));
  return node;
}

async function start(): Promise<void> {
  const app = document.querySelector<HTMLElement>("#app");
  if (!app) throw new Error("Missing proof room");
  const response = await fetch(
    new URL("evidence/index.json", document.baseURI),
  );
  if (!response.ok)
    throw new Error("Build the committed evidence before opening this site");
  const evidence = (await response.json()) as JudgeEvidence;
  if (evidence.schemaVersion !== 1 || !evidence.rounds.length)
    throw new Error("No committed evidence");
  const results = await fetch(
    new URL(evidence.benchmark.path, document.baseURI),
  );
  if (!results.ok) throw new Error("Benchmark evidence could not be loaded");
  const resultsText = await results.text();
  if ((await sha256(resultsText)) !== evidence.benchmark.digest)
    throw new Error("Benchmark evidence SHA-256 mismatch");
  const rows = parseResultsJsonl(resultsText);
  const summary = summarizeResults(rows, {
    batchId: evidence.benchmark.batchId,
  });
  const selected = rows.filter(
    (row) => row.batchId === summary.batchId && !row.dryRun,
  );
  const green = selected.filter((row) => row.status === "green").length;
  const nav = element("nav");
  nav.setAttribute("aria-label", "Evidence pages");
  nav.append(link("CHAT vs CODEX", "#top"));
  for (const [label, id] of [
    ["The numbers", "numbers"],
    ["Rounds", "rounds"],
    ["Replay it", "replay"],
    ["The build", "build"],
    ["Sandbox", "sandbox"],
  ])
    nav.append(link(label ?? "", `#${id}`));
  if (evidence.secondGame) nav.append(link("Second game", "#second-game"));
  const header = element("header");
  header.id = "top";
  const brand = element("h1", undefined, "brand");
  brand.setAttribute("aria-label", "CHAT vs CODEX");
  for (const [name, className, glyph] of [
    ["CHAT", "brand-chat", "M23 3 5 26h15l-5 19 22-28H22Z"],
    ["CODEX", "brand-codex", "m7 25 11 11L40 10"],
  ] as const) {
    if (name === "CODEX") brand.append(element("span", "vs", "brand-vs"));
    const team = element("span", undefined, className);
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("class", "brand-mark");
    mark.setAttribute("viewBox", "0 0 48 48");
    mark.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", glyph);
    mark.append(path);
    team.append(mark, element("span", name));
    brand.append(team);
  }
  header.append(
    element("p", "CHAT BREAKS IT. CODEX FIXES IT.", "eyebrow"),
    brand,
    element("p", RULE, "lede"),
  );
  const headline = element("div", undefined, "headline-stats");
  headline.append(
    stat("Planted-bug benchmark", `${green} / ${selected.length} green`),
    stat("Recorded round receipts", String(evidence.rounds.length)),
    stat("Regression replays added", `+${evidence.regressionCount}`),
  );
  header.append(headline);
  app.replaceChildren(nav, header);

  const numbers = section(
    "numbers",
    "01 / THE NUMBERS",
    "Fast enough for chat?",
  );
  const modelGrid = element("div", undefined, "model-grid");
  for (const model of [...summary.models].reverse()) {
    const card = element("article", undefined, "metric-card");
    card.dataset.model = model.model;
    card.append(
      element(
        "p",
        `${model.model.replace("gpt-6.1-", "").toUpperCase()} / ${model.effort}`,
        "eyebrow",
      ),
      element(
        "strong",
        `${((model.overall.fixRate ?? 0) * 100).toFixed(1)}%`,
        "big-number",
      ),
      element(
        "p",
        `${model.overall.green} of ${model.overall.trials} fixes verified`,
      ),
    );
    const splits = element("div", undefined, "mini-stats");
    splits.append(
      stat("Median", seconds(model.overall.medianGreenMs)),
      stat("p90", seconds(model.overall.p90GreenMs)),
      stat(
        "Median 95% CI",
        model.overall.medianGreen95CiMs?.map(seconds).join(" to ") ??
          "unavailable",
      ),
    );
    card.append(splits, element("span", model.overall.gate, "badge"));
    const table = element("table");
    const head = element("tr");
    for (const label of [
      "Family",
      "Green",
      "Rate",
      "Median",
      "p90",
      "Median 95% CI",
      "Exact reverts",
      "Before 15 s",
      "Gate",
    ])
      head.append(element("th", label));
    const tableHead = element("thead");
    tableHead.append(head);
    const body = element("tbody");
    body.append(
      metricRow("Overall", model.overall),
      ...model.families.map((family) =>
        metricRow(family.family, family.metrics),
      ),
    );
    table.append(tableHead, body);
    const scroll = element("div", undefined, "table-scroll");
    scroll.append(table);
    card.append(
      details(
        "All families + method",
        scroll,
        element(
          "p",
          `Green timings only. Nearest-rank p90. ${summary.bootstrapSamples} bootstrap resamples; seed ${summary.bootstrapSeed}. Repeated planted bugs on one level, not independently sampled production bugs.`,
        ),
      ),
    );
    modelGrid.append(card);
  }
  numbers.append(modelGrid);
  const method = element("div");
  method.append(
    element(
      "p",
      "Computed in this browser from committed JSONL. GO requires a median at most 120 s and a fix rate at least 70%, separately for each model.",
    ),
    element("code", `pnpm bench:summary --batch ${evidence.benchmark.batchId}`),
    link(
      "Recompute instructions",
      `${REPO}/blob/${evidence.commit}/bench/SUMMARY.md`,
    ),
    link("Download result JSONL", evidence.benchmark.path),
  );
  const losses = selected
    .filter((row) => row.status !== "green")
    .map((row) => ({
      trialId: row.trialId,
      status: row.status,
      reason: row.failureReason,
      elapsedMs: row.elapsedMs,
    }));
  method.append(
    element(
      "p",
      "Infrastructure losses remain in the denominator. Alternate fixes passed the full suite and held-out track.",
    ),
    json(losses),
  );
  numbers.append(details("Recompute + retained losses", method));
  app.append(numbers);
  if (evidence.secondGame) {
    const game = evidence.secondGame;
    const second = section(
      "second-game",
      "SAME REPAIR LOOP / NEW GENRE",
      "Second game",
    );
    const card = element("article", undefined, "metric-card");
    card.dataset.testid = "second-game-card";
    card.append(
      element("h3", "Breakout"),
      element(
        "p",
        "Original paddle-and-brick game. Sidecar sites leave its source unchanged.",
      ),
      element(
        "strong",
        `${game.pool.accepted} / ${game.pool.enumerated}`,
        "big-number",
      ),
      element("p", "Candidates passed every mutation gate"),
    );
    const more = element("div");
    more.append(
      element(
        "p",
        "Typecheck, minified difference, failing replay, visible divergence, bounded execution and a 20-second surviving canary.",
      ),
      element("code", `Pool SHA-256 ${game.pool.digest}`),
      element("code", `Game source SHA-256 ${game.pool.sourceDigest}`),
      element("code", "pnpm hotfix:ready gate games/breakout"),
      element("code", "pnpm breakout:bench --run"),
      link("Download gated pool", game.pool.path),
      link(
        "Inspect original game",
        `${REPO}/tree/${evidence.commit}/games/breakout`,
      ),
      link(
        "$hotfix-ready skill",
        `${REPO}/blob/${evidence.commit}/.agents/skills/hotfix-ready/SKILL.md`,
      ),
      details(
        "Sites, operators and rejected candidates",
        json({
          sites: game.pool.sites,
          operators: game.pool.operators,
          rejected: game.pool.rejected,
        }),
      ),
    );
    let trialText: string | null = null;
    if (game.benchmark) {
      const result = await fetch(
        new URL(game.benchmark.path, document.baseURI),
      );
      if (!result.ok)
        throw new Error("Second-game benchmark could not be loaded");
      trialText = await result.text();
      if ((await sha256(trialText)) !== game.benchmark.digest)
        throw new Error("Second-game benchmark SHA-256 mismatch");
      more.append(
        link("Download second-game trial results", game.benchmark.path),
      );
    }
    const measured =
      trialText === null
        ? null
        : summarizeSecondGameTrials(trialText, game.pool.sourceDigest);
    if (!measured?.models.length)
      card.append(element("p", "Runtime benchmark pending."));
    else {
      for (const model of measured.models) {
        const row = element("div", undefined, "mini-stats");
        row.dataset.testid = "second-game-metrics";
        row.dataset.model = model.model;
        row.append(
          stat(
            `${model.model} / ${model.effort}`,
            `${model.overall.green}/${model.overall.trials} fixed`,
          ),
          stat("Median", seconds(model.overall.medianGreenMs)),
          stat("p90", seconds(model.overall.p90GreenMs)),
        );
        const sample = element(
          "p",
          `n=${model.overall.trials}; ${model.families.every((family) => family.metrics.trials === 1) ? "one trial per site" : `${model.families.length} sites`}. Exploratory sample.`,
        );
        sample.dataset.testid = "second-game-sample";
        card.append(row, sample);
      }
      more.append(details("Recomputed trial statistics", json(measured)));
    }
    card.append(details("Pool, replay gates + commands", more));
    second.append(card);
    app.append(second);
  }

  const replay = section(
    "replay",
    "03 / REPLAY IT",
    "Your browser. The recorded build.",
  );
  replay.append(
    element(
      "p",
      "Re-run the validation inputs. Match the receipt's frame digest.",
    ),
  );
  const select = element("select");
  select.setAttribute("aria-label", "Round to re-simulate");
  for (const round of evidence.rounds) {
    const option = element(
      "option",
      `${roundLabel(round.receipt)} / ${round.receipt.roundId.slice(0, 8)}`,
    );
    option.value = round.receipt.roundId;
    select.append(option);
  }
  select.value =
    evidence.rounds.find(
      (round) =>
        proofAvailability(round.receipt, evidence.replay.buildDigest) === null,
    )?.receipt.roundId ??
    evidence.rounds[0]?.receipt.roundId ??
    "";
  const run = element("button", "Recompute replay");
  run.type = "button";
  run.dataset.testid = "recompute-replay";
  const result = element("p", "Ready to verify.", "proof-result");
  result.setAttribute("role", "status");
  result.dataset.testid = "proof-result";
  const canvas = element("canvas");
  canvas.width = 1280;
  canvas.height = 384;
  canvas.setAttribute(
    "aria-label",
    "Re-simulated validation route, not a live game",
  );
  const slider = element("input");
  slider.type = "range";
  slider.min = "1";
  slider.max = "600";
  slider.value = "1";
  slider.disabled = true;
  slider.setAttribute("aria-label", "Validation replay frame");
  const frameLabel = element("span", "No replay computed", "mono");
  const evidenceDetail = element("div");
  const controls = element("div", undefined, "replay-controls");
  controls.append(select, run);
  replay.append(
    controls,
    result,
    canvas,
    slider,
    frameLabel,
    details("Artifact + frame digest", evidenceDetail),
  );
  let game: GameModule | null = null;
  let frames: ValidatedReplayFrame[] = [];
  const draw = () => {
    if (!game || !frames.length) return;
    const context = canvas.getContext("2d");
    const frame = frames[Number(slider.value) - 1];
    if (!context || !frame) return;
    context.fillStyle = "#fffdf9";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const [y, row] of game.LEVEL.entries())
      for (const [x, tile] of [...row].entries()) {
        if (tile === ".") continue;
        context.fillStyle =
          tile === "#" ? "#527568" : tile === "!" ? "#e5644d" : "#0477bd";
        context.fillRect(x * 32 + 1, y * 32 + 1, 30, 30);
      }
    context.strokeStyle = "#0477bd66";
    context.lineWidth = 2;
    context.beginPath();
    for (const [index, point] of frames.entries()) {
      if (index === 0)
        context.moveTo(point.x / game.UNIT + 10, point.y / game.UNIT + 12);
      else context.lineTo(point.x / game.UNIT + 10, point.y / game.UNIT + 12);
    }
    context.stroke();
    const platform = game.platformAt(frame.frame);
    context.fillStyle = "#f7914e";
    context.fillRect(
      platform.x / game.UNIT,
      platform.y / game.UNIT,
      platform.width / game.UNIT,
      platform.height / game.UNIT,
    );
    context.fillStyle = "#0477bd";
    context.fillRect(
      frame.x / game.UNIT,
      frame.y / game.UNIT,
      game.PLAYER_WIDTH / game.UNIT,
      game.PLAYER_HEIGHT / game.UNIT,
    );
    frameLabel.textContent = `RE-SIMULATED / frame ${frame.frame} of ${frames.length} / FNV ${frame.stateHash}`;
  };
  slider.addEventListener("input", draw);
  select.addEventListener("change", () => {
    frames = [];
    slider.disabled = true;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    const receipt = evidence.rounds.find(
      (round) => round.receipt.roundId === select.value,
    )?.receipt;
    result.textContent = receipt
      ? (proofAvailability(receipt, evidence.replay.buildDigest) ??
        "Ready to verify.")
      : "No receipt";
    result.dataset.state = "idle";
    frameLabel.textContent = "No replay computed";
    evidenceDetail.replaceChildren();
  });
  run.addEventListener("click", async () => {
    const round = evidence.rounds.find(
      (row) => row.receipt.roundId === select.value,
    );
    if (!round) return;
    run.disabled = true;
    select.disabled = true;
    result.textContent = "Verifying artifact and re-simulating...";
    try {
      const unavailable = proofAvailability(
        round.receipt,
        evidence.replay.buildDigest,
      );
      if (unavailable) throw new Error(unavailable);
      if (!game) {
        const artifact = await fetch(
          new URL(evidence.replay.artifactPath, document.baseURI),
        );
        if (!artifact.ok)
          throw new Error("Recorded build artifact unavailable");
        game = await loadVerifiedGame(
          new Uint8Array(await artifact.arrayBuffer()),
          evidence.replay.buildDigest,
        );
      }
      const computed = await replayProof(game, evidence.replay, round.receipt);
      frames = computed.frames;
      slider.max = String(frames.length);
      slider.value = "1";
      slider.disabled = false;
      draw();
      result.textContent = `MATCH / ${frames.length} frames / receipt ${round.receipt.roundId.slice(0, 8)}`;
      result.dataset.state = "match";
      evidenceDetail.replaceChildren(
        json({
          buildDigest: evidence.replay.buildDigest,
          trackDigest: computed.trackDigest,
          framesDigest: computed.framesDigest,
          recordedFramesDigest: round.receipt.validationReplay?.framesDigest,
        }),
        link("Download exact simulation module", evidence.replay.artifactPath),
      );
    } catch (error) {
      result.textContent =
        error instanceof Error ? error.message : "Proof unavailable";
      result.dataset.state = "unavailable";
    } finally {
      run.disabled = false;
      select.disabled = false;
    }
  });

  const rounds = section(
    "rounds",
    "02 / RECORDED ROUNDS",
    "Every receipt. Every label.",
  );
  const roundGrid = element("div", undefined, "round-grid");
  const earlierGrid = element("div", undefined, "round-grid earlier-rounds");
  for (const round of [...evidence.rounds].reverse()) {
    const receipt = round.receipt;
    const card = element("article", undefined, "round-card");
    card.dataset.roundId = receipt.roundId;
    card.append(
      element("p", roundLabel(receipt), "eyebrow"),
      element("p", roundInputLabel(receipt), "eyebrow"),
      element("h3", receipt.family ?? "Unrecorded family"),
      element(
        "strong",
        greenSplit(receipt.durations?.timeToGreenMs),
        "round-time",
      ),
    );
    if (round.regression) card.append(element("span", "+1 test", "badge"));
    if (receipt.autopsy?.headline || receipt.autopsy?.explanation)
      card.append(
        element(
          "p",
          receipt.autopsy.headline ?? receipt.autopsy.explanation ?? "",
        ),
      );
    const patch = element("div", undefined, "patch");
    for (const line of receipt.autopsy?.patch?.preview ?? [])
      patch.append(
        element("pre", line, line.startsWith("+") ? "added" : "removed"),
      );
    if (!receipt.autopsy?.patch)
      patch.append(element("p", "This legacy receipt has no captured diff."));
    card.append(patch);
    const splitGrid = element("div", undefined, "mini-stats");
    for (const [label, value] of [
      ["Head start", receipt.durations?.headStartMs],
      ["Repair", receipt.durations?.repairMs],
      ["Tests", receipt.durations?.validationMs],
      ["Swap", receipt.durations?.swapMs],
    ] as const)
      splitGrid.append(stat(label, seconds(value)));
    const detail = element("div");
    detail.append(
      element(
        "p",
        `Saboteur ${receipt.breaker}. First correct guesser ${receipt.firstCorrectGuesser ?? "none"}. Winner ${receipt.winner}.`,
      ),
      splitGrid,
      element(
        "p",
        receipt.autopsy?.deltaMs == null
          ? "Previous-round delta unavailable."
          : `Delta ${receipt.autopsy.deltaMs < 0 ? "-" : "+"}${seconds(Math.abs(receipt.autopsy.deltaMs))} vs ${receipt.autopsy.previousRoundId ?? "previous round"}.`,
      ),
      element(
        "p",
        receipt.autopsy?.explanation ??
          "This receipt predates the autopsy card.",
      ),
      element(
        "p",
        "GREEN starts with the SDK call and ends after verified installation. The head start is separate.",
      ),
      element("code", `SHA-256 ${round.digest}`),
      link("Download round receipt", round.path),
    );
    if (round.regression)
      detail.append(
        link(
          round.regression.retroactive
            ? "Regression recorded retroactively"
            : "Download credited regression",
          round.regression.path,
        ),
      );
    const replayRound = element("button", "Recompute this round");
    replayRound.type = "button";
    replayRound.addEventListener("click", () => {
      select.value = receipt.roundId;
      select.dispatchEvent(new Event("change"));
      location.hash = "replay";
      run.click();
    });
    card.append(
      details(`Autopsy / ${receipt.roundId.slice(0, 8)}`, detail),
      replayRound,
    );
    (isEarlierTestRound(receipt) ? earlierGrid : roundGrid).append(card);
  }
  rounds.append(roundGrid);
  if (earlierGrid.childElementCount) {
    const earlier = details("Earlier test rounds", earlierGrid);
    earlier.className = "earlier-tests";
    rounds.append(earlier);
  }
  app.append(rounds, replay);

  const build = section("build", "04 / THE BUILD", "How Codex built this");
  build.append(
    element(
      "p",
      "One continuing main build session, with commits you can inspect.",
    ),
  );
  const buildStats = element("div", undefined, "headline-stats");
  buildStats.append(
    stat(
      "Commits reachable from this evidence SHA",
      String(evidence.commitCount),
    ),
    stat("Committed regression replays", String(evidence.regressionCount)),
  );
  build.append(buildStats);
  const buildDetail = element("div");
  buildDetail.append(
    element(
      "p",
      "The build thread grew from deterministic replays into a live Twitch round loop. Atomic commits preserve each step; verified fixes add a regression replay.",
    ),
    element("p", `Main session ${evidence.sessionId}`),
    element(
      "p",
      "The count is recomputed with git rev-list at build time from the pinned evidence commit. It measures reachable commits, not authorship by this session.",
    ),
    element("code", `git rev-list --count ${evidence.commit}`),
    element("code", `git log ${evidence.commit} -- chat-found/`),
    element(
      "p",
      `${evidence.regressionCommits.length} commits touched regression JSON records.`,
    ),
    link("Inspect the commit graph", `${REPO}/commits/${evidence.commit}`),
    element("code", `Evidence SHA ${evidence.commit}`),
  );
  build.append(details("Session + commit graph", buildDetail));
  app.append(build);

  const sandbox = section(
    "sandbox",
    "05 / THE SANDBOX",
    "The repair stays in its lane.",
  );
  sandbox.append(
    element(
      "p",
      "Workspace writes work. Parent files, host skills, tests and network stay protected.",
    ),
  );
  const canary = element("div", undefined, "canary-controls");
  for (const [control, outcome] of Object.entries(evidence.canary.controls))
    canary.append(
      stat(control, outcome === true ? "ALLOWED" : String(outcome)),
    );
  const canaryDetail = element("div");
  canaryDetail.append(
    canary,
    element(
      "p",
      "A completed SDK command and the kernel probe reported the same output; clean validation also passed.",
    ),
    element("p", evidence.canary.completedAt),
    element("code", `Source SHA-256 ${evidence.canary.digest}`),
    link("Download sanitized canary receipt", "evidence/sandbox-canary.json"),
    link(
      "Inspect committed source log",
      `${REPO}/blob/${evidence.commit}/${evidence.canary.path}`,
    ),
  );
  sandbox.append(details("Open sandbox canary receipt", canaryDetail));
  app.append(sandbox);
  const footer = element("footer");
  footer.append(
    element(
      "p",
      `Static evidence / ${evidence.commit.slice(0, 8)} / no account or key required`,
    ),
    link("Source on GitHub", REPO),
  );
  app.append(footer);
  document.documentElement.dataset.ready = "true";
}

start().catch((error: unknown) => {
  const app = document.querySelector("#app");
  app?.replaceChildren(
    element("h1", "Evidence unavailable"),
    element(
      "p",
      error instanceof Error
        ? error.message
        : "The evidence could not be loaded.",
    ),
  );
});
