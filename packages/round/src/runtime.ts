import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  captureRegression,
  loadRegressions,
  persistRegression,
  REGRESSIONS_DIRECTORY,
} from "../../bench/src/regressions.js";
import { createLauncher, loadProfile } from "../../bench/src/runtime.js";
import { buildTicket, HARD_BUDGET_MS } from "../../bench/src/trial.js";
import { prepareWorkspace } from "../../bench/src/workspace.js";
import {
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../../mutator/src/gate.js";
import { selectRoundMutation } from "../../mutator/src/live.js";
import { triageHint } from "../../triage/src/hint.js";
import { BUG_FAMILIES, type BugFamily } from "../../twitch/src/events.js";
import { raceBoss } from "./boss.js";
import { eventStamp } from "./clocks.js";
import type {
  GameArtifact,
  RoundRuntime,
  RuntimeObservation,
} from "./contracts.js";
import { bundleGame, type RepairExecution } from "./runtime-execution.js";
import { captureSymptom } from "./symptom.js";

export interface RoundRuntimeOptions {
  runsDirectory: string;
  model?: string;
  effort?: "low" | "high";
  /** Offline fixture selection only. Never included in the SDK ticket or workspace. */
  fixtureMutantId?: string;
  regressionsDirectory?: string;
  liveGateBudgetMs?: number;
  triageEnabled?: boolean;
  triageHint?: boolean;
}

/** A detached worker bounds SDK hangs, validation loops and bundling independently. */
export async function superviseRepair(
  options: RepairExecution,
  signal: AbortSignal,
  event: (event: ThreadEvent) => void,
  worker = new URL("./runtime-worker.ts", import.meta.url),
  observe?: (observation: RuntimeObservation) => void,
): Promise<GameArtifact> {
  signal.throwIfAborted();
  const child = fork(worker, [], {
    cwd: ROOT,
    execArgv: ["--import", "tsx"],
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const writes: Promise<void>[] = [];
  for (const [kind, stream] of [
    ["worker.stdout", child.stdout],
    ["worker.stderr", child.stderr],
  ] as const)
    stream?.on("data", (bytes: Buffer) => {
      const stamp = eventStamp();
      writes.push(
        appendFile(
          options.logFile,
          `${JSON.stringify({ ...stamp, timestamp: stamp.wallTime, kind, text: bytes.toString() })}\n`,
        ),
      );
    });
  let artifact: GameArtifact | undefined;
  let cleanExit = false;
  let workerFailed = false;
  let failure = "Runtime worker exited without a verified build";
  let stopped = false;
  let settled = false;
  const reap = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const kill = () => {
    stopped = true;
    failure = signal.aborted
      ? "Round repair aborted"
      : "Round repair deadline expired";
    reap();
  };
  signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, options.budgetMs);
  try {
    await new Promise<void>((done) => {
      child.on(
        "message",
        (message: {
          type?: string;
          event?: ThreadEvent;
          artifact?: GameArtifact;
          error?: string;
          observation?: RuntimeObservation;
        }) => {
          if (stopped || signal.aborted || settled || workerFailed) return;
          if (message.type === "event" && message.event) {
            try {
              event(message.event);
            } catch {
              failure = "Round event consumer failed";
              kill();
            }
          }
          if (message.type === "observation" && message.observation) {
            try {
              observe?.(message.observation);
            } catch {
              failure = "Round observation consumer failed";
              kill();
            }
          }
          if (message.type === "result") artifact = message.artifact;
          if (message.type === "error") {
            workerFailed = true;
            failure = message.error ?? failure;
          }
        },
      );
      child.once("error", (error) => {
        settled = true;
        failure = error.message;
        done();
      });
      child.once("exit", (code, signal) => {
        settled = true;
        cleanExit = code === 0 && signal === null;
        done();
      });
      child.send(options);
    });
    await Promise.all(writes);
    if (stopped || !artifact || !cleanExit || workerFailed)
      throw new Error(failure);
    return artifact;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", kill);
    // SDK commands may leave children after their own process exits successfully.
    reap();
  }
}

export function createRoundRuntime(
  options: RoundRuntimeOptions,
  dependencies: {
    repair?: typeof superviseRepair;
    selectMutation?: typeof selectRoundMutation;
  } = {},
): RoundRuntime {
  const runs = resolve(options.runsDirectory);
  const regressionsDirectory =
    options.regressionsDirectory ?? REGRESSIONS_DIRECTORY;
  return {
    async prepare(roundId, signal, family, boss) {
      signal.throwIfAborted();
      if (family !== undefined && !BUG_FAMILIES.includes(family))
        throw new Error("Invalid private family selection");
      const pool = JSON.parse(
        await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
      ) as { sourceDigest: string; mutants: PooledMutant[] };
      if (pool.sourceDigest !== (await sourceDigest()))
        throw new Error("Mutation pool is stale");
      const { mutant, provenance } = await (
        dependencies.selectMutation ?? selectRoundMutation
      )({
        sourceDigest: pool.sourceDigest,
        pool: pool.mutants,
        regressions: await loadRegressions(regressionsDirectory),
        signal,
        ...(family === undefined ? {} : { family }),
        ...(options.fixtureMutantId === undefined
          ? {}
          : { fixtureMutantId: options.fixtureMutantId }),
        ...(options.liveGateBudgetMs === undefined
          ? {}
          : { budgetMs: options.liveGateBudgetMs }),
      });
      await mkdir(runs, { recursive: true, mode: 0o700 });
      const logFile = join(runs, `${randomUUID()}.jsonl`);
      const workspace = await prepareWorkspace(
        mutant,
        regressionsDirectory,
        true,
      );
      let secondWorkspace:
        | Awaited<ReturnType<typeof prepareWorkspace>>
        | undefined;
      let bossSettled: Promise<void> | undefined;
      let closed = false;
      let repairStarted = false;
      const closing = new AbortController();
      let active: Promise<GameArtifact> | undefined;
      let verified = false;
      try {
        signal.throwIfAborted();
        const proof = await captureRegression(
          workspace,
          mutant,
          pool.sourceDigest,
        );
        signal.throwIfAborted();
        const clean = await bundleGame(join(ROOT, "packages/sim/src/index.ts"));
        const broken = await bundleGame(
          join(workspace.game, "src/index.ts"),
          workspace.game,
        );
        if (clean.digest === broken.digest)
          throw new Error("Mutation has no visible source artifact");
        const symptom = await captureSymptom(
          workspace.game,
          mutant,
          broken.digest,
          proof.brokenSourceDigest,
        );
        const triage =
          (options.triageEnabled ?? process.env.TRIAGE_ENABLED === "1")
            ? await (
                await import("../../triage/src/runtime.js")
              ).predictWorkspace(workspace.game, join(ROOT, "bench/triage"))
            : undefined;
        const ticket =
          buildTicket(mutant) +
          (triage && (options.triageHint ?? process.env.TRIAGE_HINT === "1")
            ? triageHint(triage)
            : "");
        if (boss) {
          secondWorkspace = await prepareWorkspace(
            mutant,
            regressionsDirectory,
            true,
          );
          const duplicate = await bundleGame(
            join(secondWorkspace.game, "src/index.ts"),
            secondWorkspace.game,
          );
          if (duplicate.digest !== broken.digest)
            throw new Error("Boss workspaces do not contain the same bug");
        }
        const profile = await loadProfile();
        const launcher = join(runs, `${randomUUID()}.launcher`);
        await createLauncher(launcher);
        const stamp = eventStamp();
        await appendFile(
          logFile,
          `${JSON.stringify({ ...stamp, timestamp: stamp.wallTime, kind: "round.prepared", mutation: provenance, roundId, mutantId: mutant.id, family: mutant.family, sourceDigest: pool.sourceDigest, cleanSourceDigest: proof.cleanSourceDigest, brokenSourceDigest: proof.brokenSourceDigest, cleanBuildDigest: clean.digest, brokenBuildDigest: broken.digest })}\n`,
          { mode: 0o600 },
        );
        signal.throwIfAborted();
        return {
          ...(triage ? { triage } : {}),
          symptom,
          family: mutant.family as BugFamily,
          mutation: provenance,
          clean,
          broken,
          ...(boss
            ? {
                boss,
                async settleBoss() {
                  await bossSettled;
                },
                repairBoss(
                  repair: Parameters<
                    NonNullable<
                      import("./contracts.js").PreparedGame["repairBoss"]
                    >
                  >[0],
                ) {
                  if (closed || repairStarted || !secondWorkspace)
                    return Promise.reject(
                      new Error("Boss repair is unavailable"),
                    );
                  repairStarted = true;
                  const combined = AbortSignal.any([
                    signal,
                    repair.signal,
                    closing.signal,
                  ]);
                  const second = secondWorkspace;
                  const race = raceBoss({
                    receipt: boss,
                    start: (model, observe) => {
                      const selected = model === "terra" ? workspace : second;
                      return (dependencies.repair ?? superviseRepair)(
                        {
                          workspace: selected,
                          launcher,
                          profile,
                          ticket,
                          hint: repair.hint,
                          model:
                            model === "terra" ? "gpt-6.1-terra" : "gpt-6.1-sol",
                          effort: model === "terra" ? "low" : "high",
                          logFile:
                            model === "terra"
                              ? logFile
                              : join(runs, `${randomUUID()}.jsonl`),
                          budgetMs: HARD_BUDGET_MS,
                        },
                        combined,
                        (event) => repair.event(event, model),
                        undefined,
                        (observation) => {
                          observe(observation);
                          repair.observe?.(observation, model);
                        },
                      );
                    },
                  });
                  bossSettled = race.settled;
                  active = race.winner.then((artifact) => {
                    verified = true;
                    return artifact;
                  });
                  return active;
                },
              }
            : {}),
          repair(repair) {
            if (closed || repairStarted)
              return Promise.reject(new Error("Game repair is unavailable"));
            if (repair.hint !== null && !BUG_FAMILIES.includes(repair.hint))
              return Promise.reject(new Error("Invalid round hint"));
            repairStarted = true;
            const combined = AbortSignal.any([
              signal,
              repair.signal,
              closing.signal,
            ]);
            active = (dependencies.repair ?? superviseRepair)(
              {
                workspace,
                launcher,
                profile,
                ticket,
                hint: repair.hint,
                model: options.model ?? "gpt-6.1-terra",
                effort: options.effort ?? "low",
                logFile,
                budgetMs: HARD_BUDGET_MS,
              },
              combined,
              repair.event,
              undefined,
              repair.observe,
            ).then((artifact) => {
              verified = true;
              return artifact;
            });
            return active;
          },
          async recordRegression(credit: { roundId: string; viewer: string }) {
            if (!verified)
              throw new Error("Regression credit requires a verified repair");
            if (credit.roundId !== roundId)
              throw new Error("Regression credit round mismatch");
            return persistRegression(regressionsDirectory, proof, credit);
          },
          async close() {
            if (closed) return;
            closed = true;
            closing.abort();
            await active?.catch(() => {});
            await bossSettled?.catch(() => {});
            await workspace.cleanup();
            await secondWorkspace?.cleanup();
          },
        };
      } catch (error) {
        await workspace.cleanup();
        await secondWorkspace?.cleanup();
        throw error;
      }
    },
  };
}
