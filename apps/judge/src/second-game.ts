import {
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import type { GatePool } from "../../../packages/hotfix-ready/src/gate.js";

export interface SecondGameEvidence {
  game: "breakout";
  pool: {
    path: string;
    digest: string;
    sourceDigest: GatePool["sourceDigest"];
    enumerated: GatePool["enumerated"];
    accepted: number;
    rejected: GatePool["rejected"];
    sites: Record<string, number>;
    operators: Record<string, number>;
  };
  benchmark: { path: string; digest: string } | null;
}

/** Consume the gate producer's schema; no headline counts are stored separately. */
export function summarizeSecondGamePool(
  text: string,
): Omit<SecondGameEvidence["pool"], "path" | "digest"> {
  const pool = JSON.parse(text) as GatePool;
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (
    pool.schemaVersion !== 1 ||
    pool.game !== "breakout" ||
    !/^[a-f0-9]{64}$/.test(pool.sourceDigest) ||
    !count(pool.enumerated) ||
    !Array.isArray(pool.mutants) ||
    !pool.mutants.length ||
    !pool.rejected ||
    typeof pool.rejected !== "object"
  )
    throw new Error("Invalid committed second-game pool");
  const rejected = Object.values(pool.rejected);
  if (
    rejected.some((value) => !count(value)) ||
    pool.mutants.length +
      rejected.reduce((total, value) => total + value, 0) !==
      pool.enumerated
  )
    throw new Error("Second-game candidate counts do not reconcile");
  const ids = new Set<string>();
  const sites: Record<string, number> = Object.create(null);
  const operators: Record<string, number> = Object.create(null);
  for (const mutant of pool.mutants) {
    const gate = mutant.gates;
    if (
      !mutant.id ||
      ids.has(mutant.id) ||
      !mutant.site ||
      !mutant.mutator ||
      !gate ||
      gate.typecheck !== true ||
      gate.differentMinifiedOutput !== true ||
      gate.killed !== true ||
      gate.visible !== true ||
      !count(gate.frameBudget) ||
      gate.frameBudget < 600 ||
      !count(gate.processBudgetMs) ||
      gate.processBudgetMs <= 0 ||
      !count(gate.canaryFrames) ||
      gate.canaryFrames < 1200 ||
      !mutant.failedReplays?.length ||
      !mutant.evidence?.some(
        (row) =>
          row.failed &&
          row.visibleFrame !== null &&
          count(row.visibleFrame) &&
          row.visibleFrame <= 600,
      )
    )
      throw new Error("Second-game mutant is missing complete gate evidence");
    ids.add(mutant.id);
    sites[mutant.site] = (sites[mutant.site] ?? 0) + 1;
    operators[mutant.mutator] = (operators[mutant.mutator] ?? 0) + 1;
  }
  return {
    sourceDigest: pool.sourceDigest,
    enumerated: pool.enumerated,
    accepted: pool.mutants.length,
    rejected: pool.rejected,
    sites,
    operators,
  };
}

/** Dry runs are excluded and source versions never get mixed into one number. */
export function summarizeSecondGameTrials(text: string, sourceDigest: string) {
  const rows = parseResultsJsonl(text);
  const batches = new Map<string, number>();
  for (const row of rows)
    if (!row.dryRun && row.sourceDigest === sourceDigest)
      batches.set(row.batchId, (batches.get(row.batchId) ?? 0) + 1);
  const batchId = [...batches.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
  return summarizeResults(rows, {
    sourceDigest,
    ...(batchId ? { batchId } : {}),
  });
}
