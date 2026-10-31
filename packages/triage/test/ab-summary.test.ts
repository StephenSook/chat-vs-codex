import { expect, it } from "vitest";
import type { TrialResult } from "../../bench/src/statistics.js";
import type { AbAssignment } from "../src/ab.js";
import { type AbResult, summarizeAb } from "../src/ab-summary.js";

const prediction = {
  family: "platformer:jump-buffer",
  confidence: 0.5,
  modelDigest: "a".repeat(64),
};
const schedule: AbAssignment[] = Array.from({ length: 30 }, (_, pair) =>
  (["without-hint", "with-hint"] as const).map((arm) => ({
    pair,
    arm,
    game: "platformer" as const,
    mutantId: `m${pair}`,
    prediction,
  })),
).flat();
const result = (assignment: AbAssignment): TrialResult => ({
  schemaVersion: 1,
  trialId: `trial-${assignment.pair}-${assignment.arm}`,
  batchId: "batch",
  mutantId: assignment.mutantId,
  family: "jump-buffer",
  model: "gpt-6.1-terra",
  effort: "low",
  status: "green",
  timeToGreenMs: assignment.arm === "with-hint" ? 15000 : 10000,
  elapsedMs: 18000,
  exactRevert: true,
  filesChanged: ["src/index.ts"],
  linesChanged: 2,
  usage: null,
  failureReason: null,
  dryRun: false,
  sourceDigest: "s",
  startedAt: "2026-10-31T12:00:00.000Z",
  answer: null,
});
const rows: AbResult[] = schedule.map((assignment) => ({
  batchId: "batch",
  assignment,
  result: result(assignment),
}));
it("reports pending before 30 per arm and keeps infrastructure losses in fix rate", () => {
  expect(summarizeAb([], schedule).status).toBe("PENDING");
  const oneLoss = structuredClone(rows);
  const first = oneLoss[0];
  if (!first) throw Error("Missing fixture");
  first.result.status = "loss";
  first.result.exactRevert = false;
  first.result.timeToGreenMs = null;
  first.result.failureReason = "transport disconnected";
  const summary = summarizeAb(oneLoss, schedule);
  expect(summary.status).toBe("COMPLETE");
  expect(summary.arms["without-hint"]?.fixRate).toBe(29 / 30);
  expect(summary.arms["with-hint"]?.medianMs).toBe(15000);
  expect(summary.pairedGreenDeltaMs.medianMs).toBe(5000);
  expect(summary.pairedGreenDeltaMs.n).toBe(29);
});
it("refuses duplicates, mixed batches and unplanned assignments", () => {
  expect(() => summarizeAb([...rows, rows[0] as AbResult], schedule)).toThrow(
    "Duplicate",
  );
  const changed = structuredClone(rows);
  const first = changed[0];
  if (!first) throw Error("Missing fixture");
  first.assignment.mutantId = "other";
  expect(() => summarizeAb(changed, schedule)).toThrow("unplanned");
  const mixed = structuredClone(rows);
  const second = mixed[1];
  if (!second) throw Error("Missing fixture");
  second.batchId = "other";
  second.result.batchId = "other";
  expect(() => summarizeAb(mixed, schedule)).toThrow("Mixed");
});

it("refuses timing comparisons across different source builds", () => {
  const changed = structuredClone(rows);
  const second = changed[1];
  if (!second) throw Error("Missing fixture");
  second.result.sourceDigest = "different-source";
  expect(() => summarizeAb(changed, schedule)).toThrow("source or bug");
});

it("requires both arms for every planned pair", () => {
  const bad = schedule.map((assignment, index) => ({
    ...assignment,
    pair: index,
    arm: "with-hint" as const,
  }));
  expect(() => summarizeAb([], bad)).toThrow("both arms");
});
