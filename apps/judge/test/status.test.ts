import { describe, expect, it } from "vitest";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import { deriveSeason } from "../../../packages/round/src/season.js";
import {
  buildJudgeEvidence,
  committedSource,
} from "../../../scripts/judge-evidence.js";
import type { Receipt } from "../src/evidence.js";
import { type JudgeStatus, judgeStatus } from "../src/status.js";

describe("public committed status", () => {
  it("recomputes root status.json from the same committed receipt and benchmark files", async () => {
    const source = committedSource();
    const before = Date.now();
    const { manifest, files } = await buildJudgeEvidence(source);
    const after = Date.now();
    const text = files.get("status.json");
    expect(text).toBeDefined();
    if (!text) throw new Error("Build omitted root status.json");
    const status = JSON.parse(text) as JudgeStatus;
    const receipts = source
      .list("docs/rounds")
      .filter((path) => path.endsWith(".json"))
      .map((path) => JSON.parse(source.read(path)) as Receipt);
    const season = deriveSeason(receipts);
    const rows = parseResultsJsonl(source.read("bench/results.jsonl"));
    const summary = summarizeResults(rows, {
      batchId: manifest.benchmark.batchId,
    });
    const selected = rows.filter(
      (row) => !row.dryRun && row.batchId === summary.batchId,
    );
    expect(status.commit).toBe(source.commit);
    expect(status.commit).toBe(manifest.commit);
    expect(Date.parse(status.builtAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(status.builtAt)).toBeLessThanOrEqual(after);
    expect(status.rounds).toEqual({
      total: receipts.length,
      viewer: season.viewers.rounds,
      test: season.tests.rounds,
      boss: season.bosses.rounds,
    });
    expect(status.benchmark).toEqual({
      batchId: summary.batchId,
      trials: selected.length,
      fixed: selected.filter((row) => row.status === "green").length,
      terraMedianMs:
        summary.models.find((row) => row.model === "gpt-6.1-terra")?.overall
          .medianGreenMs ?? null,
      solMedianMs:
        summary.models.find((row) => row.model === "gpt-6.1-sol")?.overall
          .medianGreenMs ?? null,
    });
    expect(files.has("evidence/status.json")).toBe(false);
    expect(Object.keys(status)).toEqual([
      "schemaVersion",
      "commit",
      "builtAt",
      "rounds",
      "benchmark",
    ]);
  }, 15000);

  it("validates the SHA and build time instead of emitting an unreadable receipt", () => {
    const source = committedSource();
    const summary = summarizeResults(
      parseResultsJsonl(source.read("bench/results.jsonl")),
      { batchId: "0fb7de68-5526-4ddc-bcf2-d88368d9282a" },
    );
    expect(() =>
      judgeStatus("HEAD", new Date().toISOString(), [], summary),
    ).toThrow("Invalid status commit SHA");
    for (const builtAt of [
      "yesterday",
      "2026-02-30T00:00:00.000Z",
      "2026-11-01",
    ])
      expect(() => judgeStatus(source.commit, builtAt, [], summary)).toThrow(
        "Invalid status build time",
      );
  });

  it("uses the injected build clock and refuses duplicate committed rounds", () => {
    const source = committedSource();
    const receiptPath = source
      .list("docs/rounds")
      .find((path) => path.endsWith(".json"));
    if (!receiptPath) throw new Error("No committed receipt for status test");
    const receipt = JSON.parse(source.read(receiptPath)) as Receipt;
    const summary = summarizeResults(
      parseResultsJsonl(source.read("bench/results.jsonl")),
      { batchId: "0fb7de68-5526-4ddc-bcf2-d88368d9282a" },
    );
    const builtAt = "2026-11-01T17:00:00.000Z";
    expect(
      judgeStatus(source.commit, builtAt, [receipt], summary).builtAt,
    ).toBe(builtAt);
    expect(() =>
      judgeStatus(source.commit, builtAt, [receipt, receipt], summary),
    ).toThrow("Duplicate season round");
  });

  it("keeps absent model timing null and rejects malformed benchmark evidence", () => {
    const source = committedSource();
    expect(
      judgeStatus(
        source.commit,
        "2026-11-01T17:00:00.000Z",
        [],
        summarizeResults([]),
      ).benchmark,
    ).toEqual({
      batchId: null,
      trials: 0,
      fixed: 0,
      terraMedianMs: null,
      solMedianMs: null,
    });
    expect(() => parseResultsJsonl("broken JSON")).toThrow();
  });
});
