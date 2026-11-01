import type { BatchSummary } from "../../../packages/bench/src/statistics.js";
import {
  deriveSeason,
  type SeasonReceipt,
} from "../../../packages/round/src/season.js";

/** Public build receipt. All evidence inputs come from the same pinned commit. */
export interface JudgeStatus {
  schemaVersion: 1;
  commit: string;
  builtAt: string;
  rounds: { total: number; viewer: number; test: number; boss: number };
  benchmark: {
    batchId: string | null;
    trials: number;
    fixed: number;
    terraMedianMs: number | null;
    solMedianMs: number | null;
  };
}

export function judgeStatus(
  commit: string,
  builtAt: string,
  receipts: readonly SeasonReceipt[],
  benchmark: BatchSummary,
): JudgeStatus {
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Invalid status commit SHA");
  if (
    !Number.isFinite(Date.parse(builtAt)) ||
    new Date(builtAt).toISOString() !== builtAt
  )
    throw new Error("Invalid status build time");
  const season = deriveSeason(receipts);
  const median = (model: string, effort: "low" | "high") =>
    benchmark.models.find((row) => row.model === model && row.effort === effort)
      ?.overall.medianGreenMs ?? null;
  return {
    schemaVersion: 1,
    commit,
    builtAt,
    rounds: {
      total: season.viewers.rounds + season.tests.rounds + season.bosses.rounds,
      viewer: season.viewers.rounds,
      test: season.tests.rounds,
      boss: season.bosses.rounds,
    },
    benchmark: {
      batchId: benchmark.batchId,
      trials: benchmark.models.reduce(
        (total, row) => total + row.overall.trials,
        0,
      ),
      fixed: benchmark.models.reduce(
        (total, row) => total + row.overall.green,
        0,
      ),
      terraMedianMs: median("gpt-6.1-terra", "low"),
      solMedianMs: median("gpt-6.1-sol", "high"),
    },
  };
}
