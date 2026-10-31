import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { profileHash } from "../packages/bench/src/canary.js";
import { loadProfile } from "../packages/bench/src/runtime.js";
import {
  auditSchedule,
  type ModelSpec,
  parseResultsJsonl,
  parseTrialResult,
  renderSummary,
  type ScheduleItem,
  summarizeResults,
} from "../packages/bench/src/statistics.js";
import { runTrial } from "../packages/bench/src/supervisor.js";
import { isSandboxFailure } from "../packages/bench/src/trial.js";
import {
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../packages/mutator/src/gate.js";

const args = process.argv.slice(2);
function option(flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing ${flag} value`);
  return value;
}
const modes = ["--plan", "--dry-run", "--run", "--summary"].filter((mode) =>
  args.includes(mode),
);
if (modes.length > 1) throw new Error("Choose one benchmark mode");
const mode = modes[0] ?? "--plan";
const known = new Set([
  "--plan",
  "--dry-run",
  "--run",
  "--summary",
  "--head-start",
  "--results",
  "--batch",
]);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!arg || !known.has(arg)) throw new Error(`Unknown option: ${arg}`);
  if (["--head-start", "--results", "--batch"].includes(arg)) {
    option(arg);
    i++;
  }
}
const headStart = Number(option("--head-start") ?? 15) * 1000;
if (!Number.isFinite(headStart) || headStart < 0 || headStart > 240000)
  throw new Error("Invalid chat head start");
const resultsPath = resolve(
  option("--results") ?? join(ROOT, "bench/results.jsonl"),
);
const pool = JSON.parse(
  await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
) as {
  sourceDigest: string;
  mutants: PooledMutant[];
};

async function summary(batch?: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(resultsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rows = parseResultsJsonl(text);
  let data = summarizeResults(rows, {
    headStartMs: headStart,
    ...(batch ? { batchId: batch } : {}),
  });
  if (data.models.length && data.batchId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.batchId))
      throw new Error("Invalid batch filename");
    const manifest = JSON.parse(
      await readFile(
        join(ROOT, "bench/runs", `${data.batchId}.manifest.jsonl`),
        "utf8",
      ),
    ) as {
      sourceDigest: string;
      schedule: ScheduleItem[];
    };
    if (manifest.sourceDigest !== data.sourceDigest)
      throw new Error("Manifest/source mismatch");
    data = auditSchedule(data, rows, manifest.schedule);
  }
  console.log(renderSummary(data));
}

if (mode === "--summary") {
  await summary(option("--batch"));
} else {
  if (pool.sourceDigest !== (await sourceDigest()))
    throw new Error("Pool is stale; regenerate before benchmarking");
  const specs: (ModelSpec & { repeats: number })[] = [
    { model: "gpt-6.1-terra", effort: "low", repeats: 3 },
    { model: "gpt-6.1-sol", effort: "high", repeats: 1 },
  ];
  console.log(
    `Pool: ${pool.mutants.length} mutants. Approved full budget: ${pool.mutants.length * 4} trials (${pool.mutants.length * 3} Terra low, ${pool.mutants.length} Sol high).`,
  );
  console.log(
    `Chat head start: ${headStart / 1000}s. Round:60s. Hard abort:240s. Dry run:one Terra trial, excluded from scoring.`,
  );
  if (mode !== "--plan") {
    if (mode === "--run") {
      const receipt = JSON.parse(
        await readFile(join(ROOT, ".local/bench-canary.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        receipt.passed !== true ||
        receipt.sdkObserved !== true ||
        receipt.kernelVerified !== true ||
        receipt.sdkVersion !== "0.163.0" ||
        receipt.profileHash !== profileHash(await loadProfile()) ||
        typeof receipt.verifiedAt !== "string" ||
        Date.now() - Date.parse(receipt.verifiedAt) > 24 * 60 * 60 * 1000 ||
        Date.parse(String(receipt.verifiedAt)) > Date.now() ||
        !Number.isFinite(Date.parse(String(receipt.verifiedAt)))
      )
        throw new Error(
          "Run pnpm bench:canary first; a fresh verified receipt is required",
        );
    }
    const batchId = randomUUID();
    const runsDirectory = join(ROOT, "bench/runs");
    await mkdir(runsDirectory, { recursive: true });
    const schedule =
      mode === "--dry-run"
        ? [
            {
              mutant: pool.mutants.find((m) => m.family === "gravity-sign"),
              spec: specs[0],
            },
          ]
        : pool.mutants.flatMap((mutant) =>
            specs.flatMap((spec) =>
              Array.from({ length: spec.repeats }, () => ({ mutant, spec })),
            ),
          );
    await writeFile(
      join(runsDirectory, `${batchId}.manifest.jsonl`),
      `${JSON.stringify({
        batchId,
        sourceDigest: pool.sourceDigest,
        dryRun: mode === "--dry-run",
        schedule: schedule.map(({ mutant, spec }) => ({
          mutantId: mutant?.id,
          family: mutant?.family,
          model: spec?.model,
          effort: spec?.effort,
        })),
      })}\n`,
    );
    for (const [index, { mutant, spec }] of schedule.entries()) {
      if (!mutant || !spec) throw new Error("Empty trial schedule");
      console.log(
        `Starting trial ${index + 1}/${schedule.length}: ${spec.model} ${spec.effort}`,
      );
      const result = parseTrialResult(
        await runTrial({
          ...spec,
          mutant,
          trialId: randomUUID(),
          batchId,
          sourceDigest: pool.sourceDigest,
          dryRun: mode === "--dry-run",
          runsDirectory,
        }),
      );
      await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
      console.log(
        `${result.status}; ${result.elapsedMs.toFixed(0)}ms; ${result.failureReason ?? "validated"}`,
      );
      if (
        result.status !== "green" &&
        result.failureReason &&
        isSandboxFailure(result.failureReason)
      ) {
        console.log(
          "Sandbox blocked the trial. No retry or fallback will be attempted.",
        );
        process.exitCode = 2;
        break;
      }
    }
    await summary(batchId);
  }
}
