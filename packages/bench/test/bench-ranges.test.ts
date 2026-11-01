import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { benchRanges, SCORED_BATCH } from "../../../scripts/bench-ranges.js";
import { parseResultsJsonl } from "../src/statistics.js";

const rows = parseResultsJsonl(
  execFileSync(
    "git",
    [
      "-C",
      fileURLToPath(new URL("../../../", import.meta.url)),
      "show",
      "HEAD:bench/results.jsonl",
    ],
    { encoding: "utf8" },
  ),
);

describe("committed benchmark timing ranges", () => {
  it("recomputes primary-batch per-model times from committed trial records", () => {
    expect(benchRanges(rows)).toEqual([
      {
        model: "gpt-6.1-sol",
        effort: "high",
        trials: 53,
        fixed: 53,
        minGreenMs: 21607.104833,
        medianGreenMs: 29398.723665999998,
        maxGreenMs: 54715.18825,
      },
      {
        model: "gpt-6.1-terra",
        effort: "low",
        trials: 159,
        fixed: 158,
        minGreenMs: 11647.07975,
        medianGreenMs: 14521.0729795,
        maxGreenMs: 29140.045583,
      },
    ]);
  });

  it("keeps the infrastructure loss in n and excludes dry and preliminary trials from timings", () => {
    const selected = rows.filter(
      (row) => row.batchId === SCORED_BATCH && !row.dryRun,
    );
    const losses = selected.filter((row) => row.status !== "green");
    expect(losses).toHaveLength(1);
    expect(losses[0]?.timeToGreenMs).toBeNull();
    expect(rows.some((row) => row.dryRun || row.batchId !== SCORED_BATCH)).toBe(
      true,
    );
    expect(benchRanges(rows)).toEqual(benchRanges(selected));
    expect(
      benchRanges(rows).reduce((sum, row) => sum + row.trials - row.fixed, 0),
    ).toBe(losses.length);
  });

  it("retains strict source validation and refuses an unknown batch", () => {
    const selected = rows.filter(
      (row) => row.batchId === SCORED_BATCH && !row.dryRun,
    );
    expect(() =>
      benchRanges(
        selected.map((row, index) =>
          index === 0 ? { ...row, sourceDigest: "different-source" } : row,
        ),
      ),
    ).toThrow("Mixed batches or source digests");
    expect(() => benchRanges(rows, "not-a-recorded-batch")).toThrow(
      "No scored trials",
    );
  });
});
