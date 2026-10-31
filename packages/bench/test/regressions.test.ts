import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { CANARY, runTrack } from "../../replay/src/index.js";
import { bundleGame } from "../../round/src/runtime-execution.js";
import {
  captureRegression,
  eligibleMutants,
  loadRegressions,
  mutationFingerprint,
  neutralRegressions,
  parseRegression,
  persistRegression,
  type RegressionProof,
  type RegressionRecord,
  regressionDigest,
  retroactiveRegression,
} from "../src/regressions.js";
import { prepareWorkspace } from "../src/workspace.js";

const credit = {
  roundId: "00000000-0000-0000-0000-000000000001",
  viewer: "viewer-aaaaaaaaaaaaaaaa",
};
let scratch: string;
let pool: { sourceDigest: string; mutants: PooledMutant[] };
let proof: RegressionProof;
let witness: RegressionProof;
function record(value = proof): RegressionRecord {
  return {
    ...structuredClone(value),
    ...credit,
    schemaVersion: 1,
    createdAt: "2026-10-31T12:00:00.000Z",
    retroactive: false,
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "regression-proof-test-"));
  pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  );
  for (const family of ["gravity-sign", "collision-off-by-one"]) {
    const mutant = pool.mutants.find((item) => item.family === family);
    if (!mutant) throw new Error("Missing pooled regression fixture");
    const workspace = await prepareWorkspace(mutant, join(scratch, "absent"));
    try {
      const captured = await captureRegression(
        workspace,
        mutant,
        pool.sourceDigest,
      );
      if (family === "gravity-sign") proof = captured;
      else witness = captured;
      expect(await readdir(join(workspace.game, ".tmp"))).toEqual([]);
    } finally {
      await workspace.cleanup();
    }
  }
}, 15000);
afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("chat-found replay proof", () => {
  it("records real canary inputs with clean expectations and kills the byte-verified original at its first differing frame", () => {
    expect(parseRegression(record())).toEqual(record());
    const canary = proof.routes[0];
    expect(canary?.track).toEqual(CANARY);
    expect(
      canary?.buggy.samples.every((frame) => frame.alive && !frame.won),
    ).toBe(true);
    for (const route of proof.routes) {
      const clean = runTrack(route.track);
      expect({ hashes: clean.hashes, outcome: clean.outcome }).toEqual({
        hashes: route.expected.hashes,
        outcome: route.expected.outcome,
      });
      for (const checkpoint of route.expected.checkpoints) {
        expect(checkpoint.hash).toBe(
          clean.samples[checkpoint.frame - 1]?.stateHash,
        );
        expect(route.buggy.samples[checkpoint.frame - 1]?.stateHash).not.toBe(
          checkpoint.hash,
        );
        expect(checkpoint.frame).toBe(route.firstDivergence);
      }
    }
    expect(proof.routes.some((route) => route.firstDivergence !== null)).toBe(
      true,
    );
  });

  it("keeps a surviving unchanged canary and identifies the additional failed route transparently", () => {
    const canary = witness.routes[0];
    expect(canary?.firstDivergence).toBeNull();
    expect(canary?.expected.checkpoints).toEqual([]);
    expect(witness.routes).toHaveLength(2);
    expect(witness.routes[1]).toMatchObject({
      role: "witness",
      firstDivergence: expect.any(Number),
    });
    expect(parseRegression(record(witness))).toEqual(record(witness));
  });

  it.each([
    "viewer",
    "roundId",
    "timestamp",
    "fingerprint",
    "clean expectation",
    "buggy digest",
    "survival only",
    "frame budget",
  ])("rejects invalid %s evidence", (kind) => {
    const row = record();
    const first = row.routes[0];
    if (!first) throw new Error("Missing canary");
    if (kind === "viewer") row.viewer = "real-user-id";
    if (kind === "roundId") row.roundId = "../../escape";
    if (kind === "timestamp") row.createdAt = "invalid";
    if (kind === "fingerprint") row.mutationFingerprint = "0".repeat(64);
    if (kind === "clean expectation") first.expected.outcome.x++;
    if (kind === "buggy digest") first.buggyTraceDigest = "0".repeat(64);
    if (kind === "frame budget") first.buggy.samples.pop();
    if (kind === "survival only") {
      const { hashes, outcome, samples } = runTrack(CANARY);
      first.buggy = { hashes, outcome, samples };
      first.buggyTraceDigest = createHash("sha256")
        .update(JSON.stringify(first.buggy))
        .digest("hex");
      first.firstDivergence = null;
      first.expected.checkpoints = [];
      row.routes = [first];
    }
    expect(() => parseRegression(row)).toThrow();
  });

  it("atomically persists one idempotent credit and exposes only neutral immutable fixture data", async () => {
    const directory = join(scratch, "records");
    const writes = await Promise.all([
      persistRegression(directory, proof, credit),
      persistRegression(directory, proof, credit),
    ]);
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]?.path).toBe(`chat-found/${credit.roundId}.json`);
    expect(await readdir(directory)).toEqual([`${credit.roundId}.json`]);
    const rows = await loadRegressions(directory);
    expect(rows).toHaveLength(1);
    expect(regressionDigest(rows)).toMatch(/^[a-f0-9]{64}$/);
    const neutral = neutralRegressions(rows, proof.cleanSourceDigest);
    expect(neutral).toHaveLength(1);
    expect(neutral[0]?.name).toBe("regression-0001");
    const text = JSON.stringify(neutral);
    for (const privateMetadata of [
      credit.roundId,
      credit.viewer,
      proof.mutantId,
      proof.mutationFingerprint,
      "gravity-sign",
      "canary",
      "witness",
    ])
      expect(text).not.toContain(privateMetadata);
    expect(neutralRegressions(rows, "0".repeat(64))).toEqual([]);
    await expect(
      persistRegression(directory, proof, {
        ...credit,
        viewer: "viewer-bbbbbbbbbbbbbbbb",
      }),
    ).rejects.toThrow("different regression credit");
    expect(await loadRegressions(directory)).toHaveLength(1);
  });

  it("returns no credit when persistence fails and refuses unverifiable files", async () => {
    const blocked = join(scratch, "blocked");
    await writeFile(blocked, "not a directory");
    await expect(persistRegression(blocked, proof, credit)).rejects.toThrow();
    const bad = join(scratch, "bad-record.json");
    await writeFile(bad, JSON.stringify(record()));
    await expect(loadRegressions(scratch)).rejects.toThrow("filename");
    await rm(bad);
    expect(await loadRegressions(join(scratch, "nonexistent"))).toEqual([]);
  });

  it("filters only the proven exact mutation on the matching source basis", () => {
    const rows = [parseRegression(record())];
    const eligible = eligibleMutants(pool.mutants, pool.sourceDigest, rows);
    expect(eligible).toHaveLength(pool.mutants.length - 1);
    expect(eligible.some((mutant) => mutant.id === proof.mutantId)).toBe(false);
    expect(eligible.some((mutant) => mutant.family === "gravity-sign")).toBe(
      true,
    );
    expect(eligibleMutants(pool.mutants, "0".repeat(64), rows)).toEqual(
      pool.mutants,
    );
    const other = pool.mutants.find((mutant) => mutant.id !== proof.mutantId);
    if (!other) throw new Error("Missing alternative");
    expect(mutationFingerprint(other, pool.sourceDigest)).not.toBe(
      proof.mutationFingerprint,
    );
  });

  it("refuses arbitrary or already-patched source before offline worker execution", async () => {
    const mutant = pool.mutants.find((item) => item.id === proof.mutantId);
    if (!mutant) throw new Error("Missing fixture");
    const workspace = await prepareWorkspace(mutant, join(scratch, "absent"));
    try {
      await expect(
        captureRegression(
          workspace,
          { ...mutant, replacement: "untrusted replacement" },
          pool.sourceDigest,
        ),
      ).rejects.toThrow("trusted pooled original");
      const path = join(workspace.game, "src/index.ts");
      const source = await readFile(path, "utf8");
      await writeFile(path, `${source}\n// SDK edit must never run on host\n`);
      await expect(
        captureRegression(workspace, mutant, pool.sourceDigest),
      ).rejects.toThrow("original planted source");
    } finally {
      await workspace.cleanup();
    }
  }, 10000);

  it("rejects extra attribution fields rather than persisting raw identity metadata", () => {
    expect(() =>
      parseRegression({ ...record(), actorId: "private Twitch identity" }),
    ).toThrow("Unexpected regression metadata");
    const row = record();
    if (row.routes[0]?.buggy.samples[0])
      Object.assign(row.routes[0].buggy.samples[0], {
        actorId: "private identity",
      });
    expect(() => parseRegression(row)).toThrow(
      "Unexpected regression frame metadata",
    );
  });

  it("reconstructs retroactive evidence only when original artifacts match private and public receipts, without persisting credit", async () => {
    const mutant = pool.mutants.find((item) => item.id === proof.mutantId);
    if (!mutant) throw new Error("Missing fixture");
    const workspace = await prepareWorkspace(mutant, join(scratch, "absent"));
    const directory = join(scratch, "retroactive");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory);
    try {
      const clean = await bundleGame(join(ROOT, "packages/sim/src/index.ts"));
      const broken = await bundleGame(
        join(workspace.game, "src/index.ts"),
        workspace.game,
      );
      const installs = [broken, clean].map((artifact) => ({
        buildId: artifact.id,
        statePreserved: true,
      }));
      await writeFile(
        join(directory, "result.json"),
        JSON.stringify({
          result: { roundId: credit.roundId, phase: "resolved" },
          client: { broadcast: { bug: "fixed" }, buildId: clean.id, installs },
        }),
      );
      await writeFile(
        join(directory, "runtime.jsonl"),
        [
          {
            kind: "round.prepared",
            roundId: credit.roundId,
            mutantId: mutant.id,
            family: mutant.family,
          },
          { kind: "repair.verified", digest: clean.digest },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const builds = [broken, clean].map((artifact, index) => ({
        event: {
          type: "game.build",
          roundId: credit.roundId,
          phase: index === 0 ? "broken" : "repaired",
          buildId: artifact.id,
          digest: artifact.digest,
        },
      }));
      await writeFile(
        join(directory, "events.jsonl"),
        builds.map((entry) => JSON.stringify(entry)).join("\n"),
      );
      const receiptPath = join(directory, "public-receipt.json");
      await writeFile(
        receiptPath,
        JSON.stringify({
          roundId: credit.roundId,
          breaker: credit.viewer,
          verification: {
            fullReplaySuite: true,
            heldOutReplay: true,
            statePreserved: true,
            builds: [broken, clean].map((artifact) => ({
              digest: artifact.digest,
              statePreserved: true,
            })),
          },
        }),
      );
      const input = { directory, runtimeLog: "runtime.jsonl", receiptPath };
      const result = await retroactiveRegression(input);
      expect(result).toEqual({
        proof,
        credit,
        binding: {
          mutantId: mutant.id,
          cleanBuildDigest: clean.id,
          brokenBuildDigest: broken.id,
        },
        retroactive: true,
      });
      const resultPath = join(directory, "result.json");
      const privateResult = await readFile(resultPath, "utf8");
      const unverified = JSON.parse(privateResult);
      unverified.result.phase = "rolled-back";
      await writeFile(resultPath, JSON.stringify(unverified));
      await expect(retroactiveRegression(input)).rejects.toThrow(
        "verified private result and public receipt",
      );
      await writeFile(resultPath, "{}");
      await expect(retroactiveRegression(input)).rejects.toThrow(
        "verified private result and public receipt",
      );
      await writeFile(resultPath, privateResult);
      expect(await readdir(directory)).not.toContain(`${credit.roundId}.json`);
      const changed = builds[0]?.event;
      if (!changed) throw new Error("Missing broken artifact event");
      changed.digest = "0".repeat(64);
      await readFile(join(directory, "events.jsonl"), "utf8");
      await writeFile(
        join(directory, "events.jsonl"),
        builds.map((entry) => JSON.stringify(entry)).join("\n"),
      );
      await expect(retroactiveRegression(input)).rejects.toThrow(
        "do not match recorded",
      );
    } finally {
      await workspace.cleanup();
    }
  }, 15000);
});
