import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPreflight } from "../packages/bench/src/preflight.js";
import type { TrialResult } from "../packages/bench/src/statistics.js";
import { runTrial } from "../packages/bench/src/supervisor.js";
import { isSandboxFailure } from "../packages/bench/src/trial.js";
import { sourcesDigest } from "../packages/hotfix-ready/src/gate.js";
import {
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../packages/mutator/src/gate.js";
import {
  type AbAssignment,
  planAb,
  runVerifiedAb,
} from "../packages/triage/src/ab.js";
import { summarizeAb } from "../packages/triage/src/ab-summary.js";
import { sha256, type TriageDataset } from "../packages/triage/src/dataset.js";
import { markdownTable } from "../packages/triage/src/report.js";
import type { TrainingOutput } from "../packages/triage/src/train.js";

const mode = process.argv[2] ?? "--plan";
if (!["--plan", "--run", "--summary"].includes(mode))
  throw new Error("Use --plan, --run, or --summary");
const directory = join(ROOT, "bench/triage");
const data = JSON.parse(
  await readFile(join(directory, "dataset.json"), "utf8"),
) as TriageDataset;
const training = JSON.parse(
  await readFile(join(directory, "training.json"), "utf8"),
) as TrainingOutput;
const metrics = JSON.parse(
  await readFile(join(directory, "metrics.json"), "utf8"),
) as { modelDigest: string };
const plan = planAb(data, training, metrics.modelDigest);
const resultsFile = join(directory, "ab-results.jsonl");
type AbResult = {
  batchId: string;
  assignment: AbAssignment;
  result: TrialResult;
};
if (mode === "--plan")
  console.log(
    JSON.stringify(
      {
        ...plan,
        notice:
          "60 real model calls, 30 per arm. Run only outside the build sandbox after reviewing the budget. No trials have been run by this plan.",
      },
      null,
      2,
    ),
  );
if (mode === "--summary") {
  let text = "";
  try {
    text = await readFile(resultsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rows = text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as AbResult)
    : [];
  const batch = rows.at(-1)?.batchId;
  const selected = rows.filter((r) => r.batchId === batch);
  const summary = summarizeAb(selected, plan.schedule);
  console.log(
    "# Triage A/B\n\nPaired, order randomized, Terra low. Times describe green runs only; losses stay in the fix-rate denominator.\n",
  );
  const table: string[][] = [
    ["Arm", "n", "Green", "Fix rate", "Median", "p90", "Median 95% CI"],
  ];
  for (const arm of ["without-hint", "with-hint"] as const) {
    const value = summary.arms[arm];
    const seconds = (n: number | null | undefined) =>
      n == null ? "NOT RUN" : `${(n / 1000).toFixed(2)} s`;
    table.push([
      arm,
      String(value?.trials ?? 0),
      String(value?.green ?? 0),
      value?.fixRate == null
        ? "NOT RUN"
        : `${(value.fixRate * 100).toFixed(1)}%`,
      seconds(value?.medianMs),
      seconds(value?.p90Ms),
      value?.median95CiMs?.map(seconds).join(" to ") ?? "NOT RUN",
    ]);
  }
  console.log(markdownTable(table).join("\n"));
  console.log();
  console.log(JSON.stringify(summary.pairedGreenDeltaMs));
  console.log();
  console.log(
    summary.status === "COMPLETE"
      ? "All 30 planned pairs recorded. No retry or exclusion is permitted."
      : `PENDING: ${selected.length}/60 trials recorded. No A/B effect claim is available.`,
  );
}
if (mode === "--run")
  await runVerifiedAb(
    async () => {
      execFileSync(
        process.execPath,
        ["--import", "tsx", join(ROOT, "scripts/triage.ts"), "--check"],
        {
          cwd: ROOT,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: "inherit",
        },
      );
    },
    async () => {
      const existing = await stat(resultsFile).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (existing && existing.size > 0)
        throw new Error(
          "A/B results already exist. Preserve the recorded batch; do not retry or replace trials.",
        );
      const pools = new Map<
        string,
        { sourceDigest: string; mutants: PooledMutant[] }
      >();
      for (const game of ["platformer", "breakout"] as const) {
        const path =
          game === "platformer"
            ? "packages/mutator/pool.json"
            : "games/breakout/pool.json";
        const text = await readFile(join(ROOT, path), "utf8");
        const pool = JSON.parse(text) as {
          sourceDigest: string;
          mutants: PooledMutant[];
        };
        if (
          sha256(text) !== data.poolDigests[game] ||
          pool.sourceDigest !==
            (game === "platformer"
              ? await sourceDigest()
              : await sourcesDigest(join(ROOT, "games/breakout")))
        )
          throw new Error("A/B pool or telemetry is stale");
        pools.set(game, pool);
      }
      const batchId = randomUUID();
      const runs = join(directory, "ab-runs");
      await mkdir(runs, { recursive: true });
      const manifest = join(runs, `${batchId}.manifest.json`);
      await writeFile(
        manifest,
        `${JSON.stringify({ batchId, ...plan, model: "gpt-6.1-terra", effort: "low", trialIds: plan.schedule.map(() => randomUUID()) }, null, 2)}\n`,
        { flag: "wx" },
      );
      const recorded = JSON.parse(await readFile(manifest, "utf8")) as {
        trialIds: string[];
      };
      console.log(
        "Starting exactly 60 sequential real trials (30 per arm); immutable tests, held-out route and 240 s hard budget are unchanged.",
      );
      await runPreflight(runs);
      await runPreflight(runs, undefined, "breakout");
      for (const [index, assignment] of plan.schedule.entries()) {
        const pool = pools.get(assignment.game);
        const mutant = pool?.mutants.find((m) => m.id === assignment.mutantId);
        const trialId = recorded.trialIds[index];
        if (!pool || !mutant || !trialId)
          throw new Error("Invalid immutable A/B schedule");
        const result = await runTrial({
          trialId,
          batchId,
          sourceDigest: pool.sourceDigest,
          mutant,
          model: "gpt-6.1-terra",
          effort: "low",
          dryRun: false,
          runsDirectory: runs,
          ...(assignment.game === "breakout"
            ? { gameId: "breakout" as const }
            : {}),
          ...(assignment.arm === "with-hint"
            ? { triage: assignment.prediction }
            : {}),
        });
        await appendFile(
          resultsFile,
          `${JSON.stringify({ batchId, assignment, result })}\n`,
        );
        console.log(`${index + 1}/60 ${assignment.arm}: ${result.status}`);
        if (
          result.status === "sandbox-blocked" ||
          isSandboxFailure(result.failureReason ?? "")
        )
          throw new Error(
            "A/B sandbox failure recorded; stopping without retry.",
          );
      }
    },
  );
