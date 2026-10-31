import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { TrialResult } from "../../../packages/bench/src/statistics.js";
import type { GatePool } from "../../../packages/hotfix-ready/src/gate.js";
import {
  type CommittedSource,
  committedSecondGame,
} from "../../../scripts/judge-evidence.js";
import {
  summarizeSecondGamePool,
  summarizeSecondGameTrials,
} from "../src/second-game.js";

// The real gate producer's file, not a hand-authored approximation of its output.
const poolText = readFileSync(
  new URL("../../../games/breakout/pool.json", import.meta.url),
  "utf8",
);
const pool = JSON.parse(poolText) as GatePool;
const poolPath = "games/breakout/pool.json";
const resultsPath = "games/breakout/bench/results.jsonl";

it("recomputes the retained Terra repairs as a small sample with one observation per site", () => {
  const text = readFileSync(
    new URL(`../../../${resultsPath}`, import.meta.url),
    "utf8",
  );
  const summary = summarizeSecondGameTrials(text, pool.sourceDigest);
  expect(summary.batchId).toBe("a1ea9419-27f4-4b23-8892-2e8d1d7ddebb");
  const model = summary.models[0];
  expect(summary.models).toHaveLength(1);
  expect(model).toMatchObject({
    model: "gpt-6.1-terra",
    effort: "low",
    overall: { trials: 3, green: 3, exactReverts: 3 },
  });
  expect((model?.overall.medianGreenMs ?? 0) / 1000).toBeCloseTo(17.07, 2);
  expect((model?.overall.p90GreenMs ?? 0) / 1000).toBeCloseTo(24.61, 2);
  expect(
    model?.families.map((family) => [family.family, family.metrics.trials]),
  ).toEqual([
    ["createState", 1],
    ["paddleBounce", 1],
    ["wallBounce", 1],
  ]);
});
function source(files: Map<string, string>): CommittedSource {
  return {
    commit: "a".repeat(40),
    root: "/unused",
    commitCount: () => 1,
    regressionCommits: () => [],
    list: () => [...files.keys()],
    read(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error("Uncommitted path");
      return text;
    },
  };
}

it("computes complete candidate counts from the original second-game gate schema", () => {
  const summary = summarizeSecondGamePool(poolText);
  expect(summary.accepted).toBe(pool.mutants.length);
  expect(summary.enumerated).toBe(pool.enumerated);
  expect(
    summary.accepted +
      Object.values(summary.rejected).reduce(
        (total, count) => total + count,
        0,
      ),
  ).toBe(summary.enumerated);
  expect(
    Object.values(summary.sites).reduce((total, count) => total + count, 0),
  ).toBe(summary.accepted);
  expect(
    Object.values(summary.operators).reduce((total, count) => total + count, 0),
  ).toBe(summary.accepted);
  for (const invalidate of [
    (p: GatePool) => {
      p.enumerated++;
    },
    (p: GatePool) => {
      p.mutants[0]?.failedReplays.splice(0);
    },
    (p: GatePool) => {
      if (p.mutants[0]) p.mutants[0].gates.canaryFrames = 1;
    },
    (p: GatePool) => {
      p.mutants[0]?.evidence.splice(0);
    },
  ]) {
    const invalid = structuredClone(pool);
    invalidate(invalid);
    expect(() => summarizeSecondGamePool(JSON.stringify(invalid))).toThrow();
  }
});

it("omits the card before a pool is committed and reads optional results only from committed blobs", () => {
  const emitted = new Map<string, string>();
  const emit = (path: string, text: string) => {
    const asset = `evidence/${path}`;
    emitted.set(asset, text);
    return asset;
  };
  expect(committedSecondGame(source(new Map()), emit)).toBeNull();
  expect(emitted.size).toBe(0);
  const withoutTrials = committedSecondGame(
    source(new Map([[poolPath, poolText]])),
    emit,
  );
  expect(withoutTrials?.pool.accepted).toBe(pool.mutants.length);
  expect(withoutTrials?.pool.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(withoutTrials?.benchmark).toBeNull();
  expect(emitted.get(withoutTrials?.pool.path ?? "")).toBe(poolText);
  const withEmptyTrials = committedSecondGame(
    source(
      new Map([
        [poolPath, poolText],
        [resultsPath, ""],
      ]),
    ),
    emit,
  );
  expect(withEmptyTrials?.benchmark?.path).toBe(`evidence/${resultsPath}`);
  expect(summarizeSecondGameTrials("", pool.sourceDigest).models).toEqual([]);
});

it("excludes dry runs and other source revisions rather than inventing a second-game fix rate", () => {
  const platformer = JSON.parse(
    readFileSync(
      new URL("../../../bench/results.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")[0] ?? "null",
  ) as TrialResult;
  const trial: TrialResult = {
    ...platformer,
    trialId: "second-game-dry-run",
    batchId: "second-game-test",
    sourceDigest: pool.sourceDigest,
    dryRun: true,
  };
  const text = `${JSON.stringify(platformer)}\n${JSON.stringify(trial)}\n`;
  const summary = summarizeSecondGameTrials(text, pool.sourceDigest);
  expect(summary.models).toEqual([]);
  expect(summary.excludedDryRuns).toBe(1);
});
