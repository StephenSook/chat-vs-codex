import { fork } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RegressionRecord } from "../../bench/src/regressions.js";
import { eligibleMutants } from "../../bench/src/regressions.js";
import { candidateDigest } from "./fingerprints.js";
import { FAMILIES, operatorFamily, type PooledMutant, ROOT } from "./gate.js";
import { type Candidate, enumerate } from "./index.js";

export { candidateDigest } from "./fingerprints.js";

export const LIVE_GATE_BUDGET_MS = 10_000;
export interface MutationProvenance {
  path: "live-gated" | "pool-timeout" | "fixture-pool";
  sourceDigest: string;
  candidateDigest: string;
  enumerated: number;
  eligible: number;
  attempted: number;
  budgetMs: number;
  elapsedMs: number;
  gates: PooledMutant["gates"];
}
export interface LiveGateProgress {
  enumerated: number;
  eligible: number;
  attempted: number;
}
export type LiveGateOutcome =
  | { status: "accepted"; mutant: PooledMutant; progress: LiveGateProgress }
  | { status: "timeout"; progress: LiveGateProgress };

/** Full Stryker operator x authorized-site enumeration, independent of the pool. */
export async function enumerateCandidates(root = ROOT): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const file of (await readdir(join(root, "packages/sim/src"))).sort()) {
    if (!file.endsWith(".ts") || file === "world.ts") continue;
    const name = `packages/sim/src/${file}`;
    candidates.push(
      ...(await enumerate(await readFile(join(root, name), "utf8"), name)),
    );
  }
  if (!candidates.length)
    throw new Error("No enumerated live mutation candidates");
  return candidates;
}

export function selectableCandidates(
  candidates: Candidate[],
  digest: string,
  regressions: RegressionRecord[],
  family?: string,
): Candidate[] {
  return eligibleMutants(candidates, digest, regressions).filter(
    (candidate) => {
      const classified = operatorFamily(candidate);
      return (
        FAMILIES.includes(classified as (typeof FAMILIES)[number]) &&
        (family === undefined || family === classified)
      );
    },
  );
}

/** A child process group bounds Stryker, tsc, esbuild and replay loops together.
 * Parent owns scratch cleanup even when the child is SIGKILLed at the deadline. */
export async function superviseLiveGate(
  input: {
    sourceDigest: string;
    regressions: RegressionRecord[];
    family?: string;
    budgetMs: number;
  },
  signal: AbortSignal,
  worker = new URL("./live-worker.ts", import.meta.url),
): Promise<LiveGateOutcome> {
  signal.throwIfAborted();
  const scratch = await mkdtemp(join(tmpdir(), "live-gate-"));
  try {
    return await new Promise<LiveGateOutcome>((resolve, reject) => {
      const child = fork(worker, [], {
        cwd: ROOT,
        execArgv: ["--import", "tsx"],
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let progress: LiveGateProgress = {
        enumerated: 0,
        eligible: 0,
        attempted: 0,
      };
      let result: Extract<LiveGateOutcome, { status: "accepted" }> | undefined;
      let failure: Error | undefined;
      let timeout = false;
      let exited = false;
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const abort = () => {
        failure = new Error("Live mutation gate aborted");
        kill();
      };
      const timer = setTimeout(() => {
        timeout = true;
        kill();
      }, input.budgetMs);
      signal.addEventListener("abort", abort, { once: true });
      child.on(
        "message",
        (message: {
          type?: string;
          progress?: LiveGateProgress;
          mutant?: PooledMutant;
          error?: string;
        }) => {
          if (timeout || failure || exited) return;
          if (message.progress) progress = message.progress;
          if (message.type === "accepted" && message.mutant)
            result = { status: "accepted", mutant: message.mutant, progress };
          if (message.type === "error") {
            failure = new Error(message.error ?? "Live mutation gate failed");
            kill();
          }
        },
      );
      const finish = (code: number | null) => {
        if (exited) return;
        exited = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        kill();
        if (failure) reject(failure);
        else if (timeout) resolve({ status: "timeout", progress });
        else if (code !== 0 || !result)
          reject(
            new Error("Live mutation worker exited without a gated candidate"),
          );
        else resolve(result);
      };
      child.once("error", (error) => {
        failure = error;
        finish(null);
      });
      child.once("exit", finish);
      child.send({ ...input, scratch });
      if (signal.aborted) abort();
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Pool fallback is permitted only for an exhausted wall-clock budget. */
export async function selectRoundMutation(
  input: {
    sourceDigest: string;
    pool: PooledMutant[];
    regressions: RegressionRecord[];
    signal: AbortSignal;
    family?: string;
    budgetMs?: number;
    fixtureMutantId?: string;
  },
  dependencies: {
    gate?: typeof superviseLiveGate;
    now?: () => number;
    choose?: (length: number) => number;
  } = {},
): Promise<{ mutant: PooledMutant; provenance: MutationProvenance }> {
  const budgetMs = input.budgetMs ?? LIVE_GATE_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000)
    throw new Error("Invalid live mutation budget (1 to 60000 ms)");
  input.signal.throwIfAborted();
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const eligible = eligibleMutants(
    input.pool,
    input.sourceDigest,
    input.regressions,
  ).filter(
    (mutant) =>
      FAMILIES.includes(mutant.family as (typeof FAMILIES)[number]) &&
      (input.family === undefined || mutant.family === input.family),
  );
  const outcome = input.fixtureMutantId
    ? null
    : await (dependencies.gate ?? superviseLiveGate)(
        {
          sourceDigest: input.sourceDigest,
          regressions: input.regressions,
          budgetMs,
          ...(input.family === undefined ? {} : { family: input.family }),
        },
        input.signal,
      );
  input.signal.throwIfAborted();
  const mutant =
    outcome?.status === "accepted"
      ? outcome.mutant
      : input.fixtureMutantId
        ? eligible.find((item) => item.id === input.fixtureMutantId)
        : eligible[(dependencies.choose ?? randomInt)(eligible.length || 1)];
  if (!mutant)
    throw new Error(
      "No eligible pooled mutant after live gate timeout or fixture selection",
    );
  return {
    mutant,
    provenance: {
      path: input.fixtureMutantId
        ? "fixture-pool"
        : outcome?.status === "accepted"
          ? "live-gated"
          : "pool-timeout",
      sourceDigest: input.sourceDigest,
      candidateDigest: candidateDigest(mutant),
      enumerated: outcome?.progress.enumerated ?? 0,
      eligible: outcome?.progress.eligible ?? eligible.length,
      attempted: outcome?.progress.attempted ?? 0,
      budgetMs,
      elapsedMs: Math.max(0, now() - started),
      gates: mutant.gates,
    },
  };
}
