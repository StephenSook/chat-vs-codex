import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseResultsJsonl,
  summarizeResults,
  type TrialResult,
} from "../packages/bench/src/statistics.js";

/** Frozen primary scored batch, not the latest trial or a preliminary run. */
export const SCORED_BATCH = "0fb7de68-5526-4ddc-bcf2-d88368d9282a";

export function benchRanges(rows: TrialResult[], batchId = SCORED_BATCH) {
  const summary = summarizeResults(rows, { batchId });
  if (!summary.models.length) throw new Error("No scored trials in this batch");
  return summary.models.map(({ model, effort, overall }) => {
    const times = rows
      .filter(
        (row) =>
          row.batchId === batchId &&
          !row.dryRun &&
          row.model === model &&
          row.effort === effort &&
          row.status === "green",
      )
      .map((row) => row.timeToGreenMs as number);
    return {
      model,
      effort,
      trials: overall.trials,
      fixed: overall.green,
      minGreenMs: times.length ? Math.min(...times) : null,
      medianGreenMs: overall.medianGreenMs,
      maxGreenMs: times.length ? Math.max(...times) : null,
    };
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length > 3)
    throw new Error("Usage: pnpm bench:ranges [batchId]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const text = execFileSync(
    "git",
    ["-C", root, "show", "HEAD:bench/results.jsonl"],
    { encoding: "utf8" },
  );
  console.log(
    JSON.stringify(
      benchRanges(parseResultsJsonl(text), process.argv[2]),
      null,
      2,
    ),
  );
}
