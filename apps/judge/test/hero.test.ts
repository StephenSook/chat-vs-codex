import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import type { JudgeEvidence, Receipt } from "../src/evidence.js";
import { benchmarkRaceLine, featuredRound } from "../src/hero.js";

function row(id: string): JudgeEvidence["rounds"][number] {
  return {
    path: `docs/rounds/${id}.json`,
    digest: "",
    regression: null,
    receipt: JSON.parse(
      readFileSync(
        new URL(`../../../docs/rounds/${id}.json`, import.meta.url),
        "utf8",
      ),
    ) as Receipt,
  };
}
const viewer = row("ac8b50c7-1012-4f20-af7e-10dd718b9f1c");
const boss = row("d4c4ec5f-b7e8-420e-bb16-91df94677f09");
const test = row("c37736fc-52d2-4ca0-9eee-dae78a5eff7b");

describe("first-paint race evidence", () => {
  it("features the real viewer win before a streamer boss or labelled test", () => {
    expect(viewer.receipt.winner).toBe("chat");
    expect(featuredRound([test, boss, viewer])).toBe(viewer.receipt.roundId);
  });
  it("falls back to the labelled c377 test only without a viewer race", () => {
    expect(featuredRound([boss, test])).toBe(test.receipt.roundId);
    expect(featuredRound([])).toBeNull();
  });
  it("does not relabel an unavailable real viewer comparison as a test", () => {
    expect(
      featuredRound([
        test,
        {
          ...viewer,
          comparison: {
            status: "unavailable",
            reason: "Exact build unavailable",
          },
        },
      ]),
    ).toBe(viewer.receipt.roundId);
  });
  it("computes the pace line from committed Terra trials and the benchmark head start", () => {
    const rows = parseResultsJsonl(
      readFileSync(
        new URL("../../../bench/results.jsonl", import.meta.url),
        "utf8",
      ),
    );
    const summary = summarizeResults(rows, {
      batchId: "0fb7de68-5526-4ddc-bcf2-d88368d9282a",
      bootstrapSamples: 100,
    });
    expect(benchmarkRaceLine(summary)).toBe(
      "Terra median 14.5 s · chat's head start 15 s",
    );
    const model = summary.models.find((row) => row.model === "gpt-6.1-terra");
    if (!model) throw new Error("Missing committed runtime model");
    expect(
      benchmarkRaceLine({
        ...summary,
        headStartMs: 7500,
        models: [
          { ...model, overall: { ...model.overall, medianGreenMs: 3200 } },
        ],
      }),
    ).toBe("Terra median 3.2 s · chat's head start 7.5 s");
  });
});
