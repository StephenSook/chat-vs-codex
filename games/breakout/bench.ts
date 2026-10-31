import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPreflight } from "../../packages/bench/src/preflight.js";
import {
  parseResultsJsonl,
  parseTrialResult,
  renderSummary,
  summarizeResults,
} from "../../packages/bench/src/statistics.js";
import { runTrial } from "../../packages/bench/src/supervisor.js";
import { isSandboxFailure } from "../../packages/bench/src/trial.js";
import {
  type GatePool,
  sourcesDigest,
} from "../../packages/hotfix-ready/src/gate.js";
import { ROOT } from "../../packages/mutator/src/gate.js";

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args[0] && !["--plan", "--run", "--dry-run", "--summary"].includes(args[0]))
)
  throw new Error("Choose --plan, --run, --dry-run or --summary");
const mode = args[0] ?? "--plan";
const directory = join(ROOT, "games/breakout");
const results = join(directory, "bench/results.jsonl");
const runs = join(directory, "bench/runs");
async function summary(): Promise<void> {
  let text = "";
  try {
    text = await readFile(results, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  console.log(renderSummary(summarizeResults(parseResultsJsonl(text))));
}
if (mode === "--summary") await summary();
else {
  const pool = JSON.parse(
    await readFile(join(directory, "pool.json"), "utf8"),
  ) as GatePool;
  if (pool.sourceDigest !== (await sourcesDigest(directory)))
    throw new Error("Stale Breakout pool; regenerate before benchmarking");
  if (pool.mutants.length < 3)
    throw new Error("Need at least three fully gated candidates");
  const selected = [];
  const families = new Set<string>();
  for (const mutant of pool.mutants)
    if (!families.has(mutant.family)) {
      selected.push(mutant);
      families.add(mutant.family);
      if (selected.length === 3) break;
    }
  for (const mutant of pool.mutants)
    if (selected.length < 3 && !selected.includes(mutant))
      selected.push(mutant);
  console.log(
    "Breakout: 3 total trials, gpt-6.1-terra low. Same SDK, sandbox profile, immutable replay gate and 240 s deadline as the platformer. Dry run: one excluded trial. No retries.",
  );
  if (mode !== "--plan") {
    await mkdir(runs, { recursive: true });
    await runPreflight(runs, undefined, "breakout");
    const batchId = randomUUID();
    const dryRun = mode === "--dry-run";
    const schedule = (dryRun ? selected.slice(0, 1) : selected).map(
      (mutant) => ({
        mutantId: mutant.id,
        family: mutant.family,
        model: "gpt-6.1-terra",
        effort: "low" as const,
      }),
    );
    await writeFile(
      join(runs, `${batchId}.manifest.jsonl`),
      `${JSON.stringify({ schemaVersion: 1, game: "breakout", batchId, sourceDigest: pool.sourceDigest, dryRun, schedule })}\n`,
    );
    for (const [index, item] of schedule.entries()) {
      const mutant = selected[index];
      if (!mutant) throw new Error("Schedule mismatch");
      const trialId = randomUUID();
      console.log(`Trial ${index + 1}/${schedule.length}: ${trialId}`);
      const result = parseTrialResult(
        await runTrial({
          ...item,
          gameId: "breakout",
          mutant,
          trialId,
          batchId,
          sourceDigest: pool.sourceDigest,
          dryRun,
          runsDirectory: runs,
        }),
      );
      await appendFile(results, `${JSON.stringify(result)}\n`);
      console.log(
        `${result.status}${result.timeToGreenMs === null ? "" : ` ${(result.timeToGreenMs / 1000).toFixed(2)} s`}`,
      );
      if (
        result.status === "sandbox-blocked" ||
        isSandboxFailure(result.failureReason ?? "")
      )
        throw new Error(
          "Sandbox refused the trial; batch stopped without retry. Run this same command outside the sandbox.",
        );
    }
    await summary();
  }
}
