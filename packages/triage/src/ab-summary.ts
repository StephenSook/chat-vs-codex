import {
  median,
  parseTrialResult,
  type TrialResult,
} from "../../bench/src/statistics.js";
import type { AbAssignment } from "./ab.js";
export interface AbResult {
  batchId: string;
  assignment: AbAssignment;
  result: TrialResult;
}
function timing(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length)
    return { medianMs: null, p90Ms: null, median95CiMs: null };
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const boot = Array.from(
    { length: 2000 },
    () =>
      median(
        sorted.map(() => sorted[Math.floor(random() * sorted.length)] ?? 0),
      ) ?? 0,
  ).sort((a, b) => a - b);
  return {
    medianMs: median(sorted),
    p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null,
    median95CiMs: [boot[49], boot[1949]],
  };
}
export function summarizeAb(
  rows: readonly AbResult[],
  schedule: readonly AbAssignment[],
) {
  const planned = new Map(
    schedule.map((r) => [JSON.stringify([r.pair, r.arm]), r]),
  );
  if (planned.size !== schedule.length || schedule.length !== 60)
    throw new Error("A/B schedule must contain 30 distinct pairs");
  for (let pair = 0; pair < 30; pair++) {
    const both = schedule.filter((row) => row.pair === pair);
    if (
      both.length !== 2 ||
      new Set(both.map((row) => row.arm)).size !== 2 ||
      both.some(
        (row) =>
          row.game !== both[0]?.game ||
          row.mutantId !== both[0]?.mutantId ||
          JSON.stringify(row.prediction) !==
            JSON.stringify(both[0]?.prediction),
      )
    )
      throw new Error("A/B schedule must match both arms of every pair");
  }
  const seen = new Set<string>();
  const batches = new Set<string>();
  const trialIds = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.assignment.pair, row.assignment.arm]);
    if (
      seen.has(key) ||
      JSON.stringify(planned.get(key)) !== JSON.stringify(row.assignment)
    )
      throw new Error("Duplicate or unplanned A/B result");
    seen.add(key);
    batches.add(row.batchId);
    const result = parseTrialResult(row.result);
    if (trialIds.has(result.trialId)) throw new Error("Duplicate A/B trial ID");
    trialIds.add(result.trialId);
    if (
      result.batchId !== row.batchId ||
      result.mutantId !== row.assignment.mutantId ||
      result.model !== "gpt-6.1-terra" ||
      result.effort !== "low" ||
      result.dryRun
    )
      throw new Error("A/B result does not match its assigned trial");
  }
  if (batches.size > 1) throw new Error("Mixed A/B batches");
  const arms = Object.fromEntries(
    (["without-hint", "with-hint"] as const).map((arm) => {
      const selected = rows.filter((r) => r.assignment.arm === arm);
      const greens = selected.filter((r) => r.result.status === "green");
      return [
        arm,
        {
          trials: selected.length,
          green: greens.length,
          fixRate: selected.length ? greens.length / selected.length : null,
          ...timing(greens.map((r) => r.result.timeToGreenMs ?? 0)),
        },
      ];
    }),
  );
  const paired: number[] = [];
  for (let pair = 0; pair < 30; pair++) {
    const a = rows.find(
      (r) => r.assignment.pair === pair && r.assignment.arm === "without-hint",
    );
    const b = rows.find(
      (r) => r.assignment.pair === pair && r.assignment.arm === "with-hint",
    );
    if (
      a &&
      b &&
      (a.result.sourceDigest !== b.result.sourceDigest ||
        a.result.family !== b.result.family)
    )
      throw new Error("Paired A/B source or bug differs");
    if (a?.result.status === "green" && b?.result.status === "green")
      paired.push(
        (b.result.timeToGreenMs ?? 0) - (a.result.timeToGreenMs ?? 0),
      );
  }
  return {
    status: seen.size === 60 ? "COMPLETE" : "PENDING",
    recorded: seen.size,
    planned: 60,
    arms,
    pairedGreenDeltaMs: {
      n: paired.length,
      definition: "with hint minus without hint, both-green pairs only",
      ...timing(paired),
    },
  };
}
