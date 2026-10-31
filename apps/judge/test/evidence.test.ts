import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../../../packages/bench/src/statistics.js";
import {
  buildJudgeEvidence,
  canaryReceipt,
  committedSource,
  MAIN_SESSION_ID,
} from "../../../scripts/judge-evidence.js";

describe("committed judge evidence", () => {
  it("pins immutable Git blobs and ignores working-tree and untracked evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "judge-evidence-"));
    // GIT_DIR belongs to the caller's main repo; this test owns an isolated Git repo.
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { env, stdio: "pipe" });
    const previous = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    try {
      git("init", "-q");
      await writeFile(join(root, "proof.json"), "committed");
      git("add", "proof.json");
      git(
        "-c",
        "user.name=Stephen Sookra",
        "-c",
        "user.email=stephensookra@gmail.com",
        "commit",
        "-qm",
        "Record evidence",
      );
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      const source = committedSource(root);
      await writeFile(join(root, "proof.json"), "private dirty edit");
      await writeFile(join(root, "not-committed.json"), "private");
      expect(source.read("proof.json")).toBe("committed");
      expect(source.list(".")).toEqual(["proof.json"]);
      expect(source.commitCount()).toBe(1);
      expect(source.read("proof.json")).not.toContain("private");
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports real committed receipts, shared benchmark inputs and a matching exact simulation artifact", async () => {
    const { manifest, files } = await buildJudgeEvidence();
    expect(manifest.sessionId).toBe(MAIN_SESSION_ID);
    const source = committedSource();
    expect(
      manifest.rounds.map((round) => round.path.replace(/^evidence\//, "")),
    ).toEqual(
      source.list("docs/rounds").filter((path) => path.endsWith(".json")),
    );
    expect(files.get(manifest.benchmark.path)).toBe(
      source.read("bench/results.jsonl"),
    );
    const summary = summarizeResults(
      parseResultsJsonl(files.get(manifest.benchmark.path) ?? ""),
      { batchId: manifest.benchmark.batchId },
    );
    expect(
      summary.models.reduce((sum, model) => sum + model.overall.trials, 0),
    ).toBeGreaterThan(0);
    const withReplay = manifest.rounds.filter(
      (round) =>
        round.receipt.validationReplay?.buildDigest ===
        manifest.replay.buildDigest,
    );
    expect(withReplay.length).toBeGreaterThan(0);
    expect(manifest.regressionCount).toBe(
      source.list("chat-found").filter((path) => path.endsWith(".json")).length,
    );
    expect([...files.keys()].some((path) => path.includes(".local"))).toBe(
      false,
    );
    expect(manifest.canary.controls.parent).toBe("EPERM");
  }, 15000);

  it("requires matching successful SDK and kernel results, positive controls and clean validation", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const path = "bench/runs/canary-f95f8d5d-fadb-48d3-91dd-70909d56c380.jsonl";
    const text = await readFile(join(root, path), "utf8");
    expect(canaryReceipt(path, text).sdkOutputMatchesKernel).toBe(true);
    for (const bad of [
      text.replace('"kernelStatus":0', '"kernelStatus":1'),
      text.replaceAll('"turn.completed"', '"turn.failed"'),
      text.replace('"cleanValidation":"passed"', '"cleanValidation":"failed"'),
      text.replaceAll('\\"tempDirectory\\":true', '\\"tempDirectory\\":false'),
    ])
      expect(() => canaryReceipt(path, bad)).toThrow();
  });
});
