import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PooledMutant, ROOT } from "../src/gate.js";
import {
  candidateDigest,
  enumerateCandidates,
  selectableCandidates,
  selectRoundMutation,
  superviseLiveGate,
} from "../src/live.js";
import { trustedOriginalMutation } from "../src/trust.js";

const pool = JSON.parse(
  await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
) as { sourceDigest: string; mutants: PooledMutant[]; candidateCount: number };
const mutant = pool.mutants.find((row) => row.family === "gravity-sign");
if (!mutant) throw new Error("Missing fixture");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const input = () => ({
  sourceDigest: pool.sourceDigest,
  pool: pool.mutants,
  regressions: [],
  signal: new AbortController().signal,
});
const progress = { enumerated: 160, eligible: 60, attempted: 2 };

describe("bounded round-time mutation generation", () => {
  it("enumerates full operators x sites, including candidates absent from the pool", async () => {
    const candidates = await enumerateCandidates();
    expect(candidates).toHaveLength(pool.candidateCount);
    expect(candidates.length).toBeGreaterThan(pool.mutants.length);
    expect(new Set(candidates.map((candidate) => candidate.site))).toEqual(
      new Set(["physics", "input", "collision", "coyote", "buffer", "enemy"]),
    );
    const subset = selectableCandidates(
      candidates,
      pool.sourceDigest,
      [],
      "gravity-sign",
    );
    expect(subset).toHaveLength(3);
    const newCandidate = candidates.find(
      (candidate) => !pool.mutants.some((row) => row.id === candidate.id),
    );
    if (!newCandidate) throw new Error("Missing nonpool candidate");
    expect(await trustedOriginalMutation({ ...mutant, ...newCandidate })).toBe(
      true,
    );
    expect(
      await trustedOriginalMutation({
        ...mutant,
        replacement: "process.exit(1)",
      }),
    ).toBe(false);
  });
  it("selects an actually gated candidate outside the supplied fallback pool", async () => {
    const fallback = pool.mutants.filter((row) => row.id !== mutant.id);
    const result = await selectRoundMutation(
      { ...input(), pool: fallback },
      {
        gate: async () => ({ status: "accepted", mutant, progress }),
        now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(45),
      },
    );
    expect(result.mutant).toEqual(mutant);
    expect(result.provenance).toMatchObject({
      path: "live-gated",
      candidateDigest: candidateDigest(mutant),
      ...progress,
      elapsedMs: 35,
      budgetMs: 10000,
      gates: mutant.gates,
    });
  });
  it("falls back only on an explicit supervisor deadline", async () => {
    const result = await selectRoundMutation(input(), {
      gate: async () => ({ status: "timeout", progress }),
      choose: () => 0,
    });
    expect(result.provenance.path).toBe("pool-timeout");
    expect(result.provenance.attempted).toBe(2);
    const choose = vi.fn(() => 0);
    await expect(
      selectRoundMutation(input(), {
        gate: async () => {
          throw new Error("All candidates rejected");
        },
        choose,
      }),
    ).rejects.toThrow("All candidates rejected");
    expect(choose).not.toHaveBeenCalled();
  });
  it("never starts a live gate for an explicit fixture and labels its origin", async () => {
    const gate = vi.fn();
    const result = await selectRoundMutation(
      { ...input(), fixtureMutantId: mutant.id },
      { gate },
    );
    expect(gate).not.toHaveBeenCalled();
    expect(result.provenance.path).toBe("fixture-pool");
  });
  it("does not turn cancellation or an invalid budget into fallback", async () => {
    await expect(
      selectRoundMutation({ ...input(), budgetMs: 0 }),
    ).rejects.toThrow("budget");
    const abort = new AbortController();
    abort.abort();
    await expect(
      selectRoundMutation({ ...input(), signal: abort.signal }),
    ).rejects.toThrow();
  });
  it("kills and reaps a genuinely stuck gate worker by the hard deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-worker-test-"));
    roots.push(dir);
    const worker = join(dir, "stuck.mjs");
    await writeFile(
      worker,
      'process.once("message",()=>{process.send({type:"progress",progress:{enumerated:160,eligible:60,attempted:1}});setInterval(()=>{},1000);});',
    );
    const result = await superviseLiveGate(
      { sourceDigest: pool.sourceDigest, regressions: [], budgetMs: 1000 },
      new AbortController().signal,
      pathToFileURL(worker),
    );
    expect(result.status).toBe("timeout");
    expect(result.progress.attempted).toBe(1);
  });
  it("propagates real worker errors and never calls them a timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-worker-error-"));
    roots.push(dir);
    const worker = join(dir, "error.mjs");
    await writeFile(
      worker,
      'process.once("message",()=>{process.send({type:"error",error:"clean source typecheck failed"});process.disconnect();});',
    );
    await expect(
      superviseLiveGate(
        { sourceDigest: pool.sourceDigest, regressions: [], budgetMs: 5000 },
        new AbortController().signal,
        pathToFileURL(worker),
      ),
    ).rejects.toThrow("clean source typecheck failed");
  });
});

it("gates an actual freshly enumerated original with tsc, replay, visibility and survival checks", async () => {
  const outcome = await superviseLiveGate(
    {
      sourceDigest: pool.sourceDigest,
      regressions: [],
      family: "gravity-sign",
      budgetMs: 20000,
    },
    new AbortController().signal,
  );
  expect(outcome.status).toBe("accepted");
  if (outcome.status !== "accepted")
    throw new Error("Real live gate timed out");
  expect(outcome.progress.enumerated).toBe(pool.candidateCount);
  expect(outcome.progress.eligible).toBe(3);
  expect(outcome.progress.attempted).toBeGreaterThan(0);
  expect(outcome.mutant.family).toBe("gravity-sign");
  expect(outcome.mutant.failedReplays.length).toBeGreaterThan(0);
  expect(outcome.mutant.evidence.some((row) => row.visibleFrame !== null)).toBe(
    true,
  );
  expect(outcome.mutant.gates).toMatchObject({
    typecheck: true,
    differentMinifiedOutput: true,
    killed: true,
    visible: true,
    frameBudget: 3600,
    processBudgetMs: 3000,
    canaryFrames: 1200,
  });
}, 25000);
