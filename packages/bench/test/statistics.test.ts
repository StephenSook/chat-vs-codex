import { describe, expect, it } from "vitest";
import {
  auditSchedule,
  median,
  parseResultsJsonl,
  parseTrialResult,
  renderSummary,
  type ScheduleItem,
  summarizeResults,
  type TrialResult,
} from "../src/statistics.js";

function trial(index: number, changes: Partial<TrialResult> = {}): TrialResult {
  return {
    schemaVersion: 1,
    trialId: `trial-${index}`,
    batchId: "batch-1",
    mutantId: `mutant-${index}`,
    family: "gravity-sign",
    model: "gpt-6.1-terra",
    effort: "low",
    status: "green",
    timeToGreenMs: 10000,
    elapsedMs: 11000,
    exactRevert: true,
    filesChanged: ["src/step.ts"],
    linesChanged: 2,
    usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 },
    failureReason: null,
    dryRun: false,
    sourceDigest: "test-source-digest",
    startedAt: "2026-10-30T12:00:00.000Z",
    answer: {
      rootCause: "Incorrect direction",
      file: "src/step.ts",
      line: 1,
      explanation: "The direction was reversed.",
      confidence: 0.9,
    },
    ...changes,
  };
}

function loss(index: number): TrialResult {
  return trial(index, {
    status: "loss",
    timeToGreenMs: null,
    exactRevert: false,
    elapsedMs: 240000,
    failureReason: "Deadline exceeded",
  });
}

describe("benchmark result parser", () => {
  it("round-trips the producer's exported result type and accepts an empty file", () => {
    const rows = [trial(1), loss(2)];
    expect(
      parseResultsJsonl(
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ).toEqual(rows);
    expect(parseResultsJsonl("")).toEqual([]);
  });

  it("refuses malformed, blank, truncated and duplicate result lines with a line number", () => {
    for (const bad of [
      "broken",
      "{}",
      "",
      JSON.stringify(trial(1)).slice(0, -1),
    ]) {
      expect(() =>
        parseResultsJsonl(`${JSON.stringify(trial(1))}\n${bad}\n`),
      ).toThrow("Result line 2");
    }
    expect(() =>
      parseResultsJsonl(
        `${JSON.stringify(trial(1))}\n${JSON.stringify(trial(1))}`,
      ),
    ).toThrow("Duplicate trialId");
  });

  it.each([
    { schemaVersion: 2 },
    { unknownField: true },
    { model: "" },
    { effort: "medium" },
    { status: "passed" },
    { status: { toString: (): string => "loss" } },
    { startedAt: "yesterday" },
    { startedAt: "2026-02-31T12:00:00.000Z" },
    { elapsedMs: Number.NaN },
    { elapsedMs: Number.POSITIVE_INFINITY },
    { timeToGreenMs: 0 },
    { timeToGreenMs: 12000, elapsedMs: 11000 },
    { timeToGreenMs: 240001, elapsedMs: 240001 },
    { failureReason: "Actually failed" },
    { dryRun: "false" },
    { exactRevert: 1 },
    { linesChanged: 1.2 },
    { filesChanged: ["src/step.ts", "src/step.ts"] },
    { usage: { input_tokens: 5, cached_input_tokens: 6, output_tokens: 0 } },
    { usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: -1 } },
    {
      answer: {
        rootCause: "Cause",
        file: "src/step.ts",
        line: 0,
        explanation: "Fix",
        confidence: 0.5,
      },
    },
    {
      answer: {
        rootCause: "Cause",
        file: "src/step.ts",
        line: 1,
        explanation: "Fix",
        confidence: 1.01,
      },
    },
  ])("rejects invalid record %#", (changes) => {
    expect(() => parseTrialResult({ ...trial(1), ...changes })).toThrow();
  });

  it("does not let failure records carry successful timings or exact revert claims", () => {
    expect(() => parseTrialResult({ ...loss(1), timeToGreenMs: 1 })).toThrow(
      "Non-green",
    );
    expect(() => parseTrialResult({ ...loss(1), exactRevert: true })).toThrow(
      "exact revert",
    );
    expect(() => parseTrialResult({ ...loss(1), failureReason: null })).toThrow(
      "failureReason",
    );
    expect(() =>
      parseTrialResult({ ...loss(1), status: "sandbox-blocked" }),
    ).toThrow("dry run");
  });
});

describe("persisted benchmark schedule", () => {
  const planned = (rows: TrialResult[]): ScheduleItem[] =>
    rows.map(({ mutantId, family, model, effort }) => ({
      mutantId,
      family,
      model,
      effort,
    }));

  it("leaves first-green metrics provisional until every scheduled occurrence exists", () => {
    const all = [
      trial(1, { mutantId: "a" }),
      trial(2, { mutantId: "a" }),
      trial(3, { mutantId: "a" }),
      trial(4, { mutantId: "a", model: "gpt-6.1-sol", effort: "high" }),
    ];
    const first = all.slice(0, 1);
    const original = summarizeResults(first);
    const result = auditSchedule(original, first, planned(all));
    expect(original.models[0]?.overall.gate).toBe("GO");
    expect(
      result.models.find((model) => model.model === "gpt-6.1-terra")?.overall,
    ).toMatchObject({
      green: 1,
      fixRate: 1,
      gate: "NO DATA",
      camera: "INSUFFICIENT SAMPLE",
    });
    expect(
      result.models.find((model) => model.model === "gpt-6.1-sol")?.overall,
    ).toMatchObject({ trials: 0, gate: "NO DATA" });
  });

  it("allows each complete model independently while another is still incomplete", () => {
    const terra = Array.from({ length: 12 }, (_, index) =>
      trial(index, { mutantId: `m${Math.floor(index / 3)}` }),
    );
    const sol = Array.from({ length: 4 }, (_, index) =>
      trial(index + 20, {
        mutantId: `m${index}`,
        model: "gpt-6.1-sol",
        effort: "high",
      }),
    );
    const partial = [...terra, sol[0] as TrialResult];
    const result = auditSchedule(
      summarizeResults(partial),
      partial,
      planned([...terra, ...sol]),
    );
    expect(
      result.models.find((model) => model.model === "gpt-6.1-terra")?.overall,
    ).toMatchObject({ trials: 12, gate: "GO", camera: "QUALIFIES" });
    expect(
      result.models.find((model) => model.model === "gpt-6.1-sol")?.overall
        .gate,
    ).toBe("NO DATA");
    const complete = auditSchedule(
      summarizeResults([...terra, ...sol]),
      [...terra, ...sol],
      planned([...terra, ...sol]),
    );
    expect(complete.models.every((model) => model.overall.gate === "GO")).toBe(
      true,
    );
  });

  it("rejects extra runs, unknown mutants, family mismatches and unplanned models", () => {
    const rows = [trial(1)];
    const schedule = planned(rows);
    for (const extra of [
      trial(2, { mutantId: rows[0]?.mutantId ?? "" }),
      trial(2),
      trial(2, { family: "swapped-controls" }),
      trial(2, { model: "gpt-6.1-sol", effort: "high" }),
    ]) {
      const actual = [...rows, extra];
      expect(() =>
        auditSchedule(summarizeResults(actual), actual, schedule),
      ).toThrow(/scheduled|Unscheduled/);
    }
    expect(() => auditSchedule(summarizeResults(rows), rows, [])).toThrow(
      "empty",
    );
    expect(() =>
      auditSchedule(summarizeResults(rows), rows, [
        ...schedule,
        { ...(schedule[0] as ScheduleItem), family: "jump-buffer" },
      ]),
    ).toThrow("conflicting families");
  });

  it("ignores dry runs and other bound batches while refusing a stale supplied summary", () => {
    const row = trial(1);
    const rows = [
      row,
      trial(2, { dryRun: true }),
      trial(3, { batchId: "other", sourceDigest: "other" }),
    ];
    const summary = summarizeResults(rows, {
      batchId: "batch-1",
      sourceDigest: "test-source-digest",
    });
    expect(
      auditSchedule(summary, rows, planned([row])).models[0]?.overall.trials,
    ).toBe(1);
    const extraPlanned = [...planned([row]), ...planned([trial(4)])];
    expect(
      auditSchedule(summary, [], extraPlanned).models[0]?.overall.gate,
    ).toBe("NO DATA");
  });
});

describe("benchmark summary", () => {
  it("keeps failures in the denominator and reports exact reverts on both bases", () => {
    const rows = [
      trial(1),
      trial(2, { exactRevert: false, timeToGreenMs: 30000, elapsedMs: 31000 }),
      loss(3),
      loss(4),
    ];
    const metrics = summarizeResults(rows).models[0]?.overall;
    expect(metrics).toMatchObject({
      trials: 4,
      green: 2,
      fixRate: 0.5,
      medianGreenMs: 20000,
      p90GreenMs: 30000,
      exactReverts: 1,
      exactRevertRateAmongGreen: 0.5,
      exactRevertRateAllTrials: 0.25,
      greensBeforeHeadStart: 1,
      gate: "NO-GO",
      camera: "INSUFFICIENT SAMPLE",
    });
  });

  it("reports successful timing distributions separately by model and family", () => {
    const summary = summarizeResults([
      trial(1),
      trial(2, {
        family: "jump-buffer",
        timeToGreenMs: 20000,
        elapsedMs: 21000,
      }),
      trial(3, {
        model: "gpt-6.1-sol",
        effort: "high",
        timeToGreenMs: 60000,
        elapsedMs: 61000,
      }),
    ]);
    expect(summary.models).toHaveLength(2);
    expect(
      summary.models.find((row) => row.model === "gpt-6.1-sol")?.overall
        .medianGreenMs,
    ).toBe(60000);
    const terra = summary.models.find((row) => row.model === "gpt-6.1-terra");
    expect(terra?.overall.medianGreenMs).toBe(15000);
    expect(
      terra?.families.map((row) => [row.family, row.metrics.medianGreenMs]),
    ).toEqual([
      ["gravity-sign", 10000],
      ["jump-buffer", 20000],
    ]);
  });

  it("returns NO DATA without scoring dry runs, including sandbox failures", () => {
    const summary = summarizeResults([
      trial(1, { dryRun: true }),
      { ...loss(2), dryRun: true, status: "sandbox-blocked" },
    ]);
    expect(summary.models).toEqual([]);
    expect(summary.excludedDryRuns).toBe(2);
    expect(renderSummary(summary)).toContain("NO DATA");
    expect(summarizeResults([]).models).toEqual([]);
  });

  it("refuses mixed source or batch evidence unless a matching selection is explicit", () => {
    const rows = [
      trial(1),
      trial(2, { batchId: "batch-2", sourceDigest: "different-source" }),
    ];
    expect(() => summarizeResults(rows)).toThrow("Mixed batches");
    expect(
      summarizeResults(rows, {
        batchId: "batch-2",
        sourceDigest: "different-source",
      }).models[0]?.overall.trials,
    ).toBe(1);
    expect(() => summarizeResults([trial(1), trial(1)])).toThrow(
      "Duplicate trialId",
    );
  });

  it("uses ordinary median and nearest-rank p90", () => {
    expect(median([])).toBeNull();
    expect(median([9, 1, 2])).toBe(2);
    expect(median([9, 1, 4, 2])).toBe(3);
    const rows = Array.from({ length: 10 }, (_, index) =>
      trial(index, { timeToGreenMs: (index + 1) * 1000 }),
    );
    expect(summarizeResults(rows).models[0]?.overall).toMatchObject({
      medianGreenMs: 5500,
      p90GreenMs: 9000,
    });
  });

  it("bootstraps a reproducible CI and states the calculation in rendered output", () => {
    const rows = [
      trial(1),
      trial(2, { timeToGreenMs: 20000, elapsedMs: 21000 }),
      trial(3, { timeToGreenMs: 30000, elapsedMs: 31000 }),
    ];
    const first = summarizeResults(rows, { seed: 17, bootstrapSamples: 1000 });
    const second = summarizeResults([...rows].reverse(), {
      seed: 17,
      bootstrapSamples: 1000,
    });
    expect(first.models[0]?.overall.medianGreen95CiMs).toEqual([10000, 30000]);
    expect(second.models[0]?.overall.medianGreen95CiMs).toEqual(
      first.models[0]?.overall.medianGreen95CiMs,
    );
    expect(
      summarizeResults([trial(1)]).models[0]?.overall.medianGreen95CiMs,
    ).toEqual([10000, 10000]);
    const rendered = renderSummary(first);
    expect(rendered).toContain("green trials only");
    expect(rendered).toContain("nearest rank");
    expect(rendered).toContain("1000 samples, seed 17");
  });

  it("treats exactly 15 s as not before the head start and exactly 60 s as within the round", () => {
    const rows = [
      trial(1, { timeToGreenMs: 15000, elapsedMs: 16000 }),
      trial(2, { timeToGreenMs: 60000, elapsedMs: 61000 }),
    ];
    expect(summarizeResults(rows).models[0]?.overall).toMatchObject({
      greensBeforeHeadStart: 0,
      greenWithinRound: 2,
    });
    expect(
      summarizeResults(rows, { headStartMs: 16000 }).models[0]?.overall
        .greensBeforeHeadStart,
    ).toBe(1);
  });

  it("requires the full success threshold and enough runs for camera qualification", () => {
    const ten = [
      ...Array.from({ length: 8 }, (_, index) => trial(index)),
      loss(8),
      loss(9),
    ];
    expect(summarizeResults(ten).models[0]?.overall).toMatchObject({
      gate: "GO",
      camera: "QUALIFIES",
    });
    expect(
      summarizeResults([...ten.slice(0, 7), loss(7), loss(8), loss(9)])
        .models[0]?.overall,
    ).toMatchObject({ gate: "GO", camera: "DOES NOT QUALIFY" });
    expect(summarizeResults(ten.slice(0, 9)).models[0]?.overall.camera).toBe(
      "INSUFFICIENT SAMPLE",
    );
    expect(
      summarizeResults([trial(1, { timeToGreenMs: 120000, elapsedMs: 120000 })])
        .models[0]?.overall.gate,
    ).toBe("GO");
    expect(
      summarizeResults([trial(1, { timeToGreenMs: 120001, elapsedMs: 120001 })])
        .models[0]?.overall.gate,
    ).toBe("NO-GO");
    expect(summarizeResults([loss(1)]).models[0]?.overall).toMatchObject({
      gate: "NO-GO",
      medianGreenMs: null,
      p90GreenMs: null,
      medianGreen95CiMs: null,
    });
  });

  it("refuses meaningless statistical settings", () => {
    for (const settings of [
      { headStartMs: -1 },
      { bootstrapSamples: 0 },
      { seed: -1 },
      { seed: 4294967296 },
    ]) {
      expect(() => summarizeResults([], settings)).toThrow();
    }
  });
});
