import { fork } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createLauncher, loadProfile } from "../../bench/src/runtime.js";
import { buildTicket, HARD_BUDGET_MS } from "../../bench/src/trial.js";
import { prepareWorkspace } from "../../bench/src/workspace.js";
import {
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../../mutator/src/gate.js";
import { BUG_FAMILIES, type BugFamily } from "../../twitch/src/events.js";
import type { GameArtifact, RoundRuntime } from "./contracts.js";
import { bundleGame, type RepairExecution } from "./runtime-execution.js";

export interface RoundRuntimeOptions {
  runsDirectory: string;
  model?: string;
  effort?: "low" | "high";
  /** Offline fixture selection only. Never included in the SDK ticket or workspace. */
  fixtureMutantId?: string;
}

/** A detached worker bounds SDK hangs, validation loops and bundling independently. */
export async function superviseRepair(
  options: RepairExecution,
  signal: AbortSignal,
  event: (event: ThreadEvent) => void,
  worker = new URL("./runtime-worker.ts", import.meta.url),
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
      writes.push(
        appendFile(
          options.logFile,
          `${JSON.stringify({ timestamp: new Date().toISOString(), kind, text: bytes.toString() })}\n`,
        ),
      );
    });
  let artifact: GameArtifact | undefined;
  let cleanExit = false;
  let workerFailed = false;
  let failure = "Runtime worker exited without a verified build";
  let stopped = false;
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
        }) => {
          if (message.type === "event" && message.event && !stopped) {
            try {
              event(message.event);
            } catch {
              failure = "Round event consumer failed";
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
        failure = error.message;
        done();
      });
      child.once("exit", (code, signal) => {
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

export function createRoundRuntime(options: RoundRuntimeOptions): RoundRuntime {
  const runs = resolve(options.runsDirectory);
  return {
    async prepare(roundId, signal) {
      signal.throwIfAborted();
      const pool = JSON.parse(
        await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
      ) as { sourceDigest: string; mutants: PooledMutant[] };
      if (pool.sourceDigest !== (await sourceDigest()))
        throw new Error("Mutation pool is stale");
      const eligible = pool.mutants.filter((mutant) =>
        BUG_FAMILIES.includes(mutant.family as BugFamily),
      );
      const mutant = options.fixtureMutantId
        ? eligible.find((item) => item.id === options.fixtureMutantId)
        : eligible[randomInt(eligible.length || 1)];
      if (!mutant) throw new Error("No eligible pooled mutant");
      await mkdir(runs, { recursive: true, mode: 0o700 });
      const logFile = join(runs, `${randomUUID()}.jsonl`);
      const workspace = await prepareWorkspace(mutant);
      let closed = false;
      let repairStarted = false;
      const closing = new AbortController();
      let active: Promise<GameArtifact> | undefined;
      try {
        signal.throwIfAborted();
        const clean = await bundleGame(join(ROOT, "packages/sim/src/index.ts"));
        const broken = await bundleGame(
          join(workspace.game, "src/index.ts"),
          workspace.game,
        );
        if (clean.digest === broken.digest)
          throw new Error("Mutation has no visible source artifact");
        const profile = await loadProfile();
        const launcher = join(runs, `${randomUUID()}.launcher`);
        await createLauncher(launcher);
        await appendFile(
          logFile,
          `${JSON.stringify({ timestamp: new Date().toISOString(), kind: "round.prepared", roundId, mutantId: mutant.id, family: mutant.family })}\n`,
          { mode: 0o600 },
        );
        signal.throwIfAborted();
        return {
          family: mutant.family as BugFamily,
          clean,
          broken,
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
            active = superviseRepair(
              {
                workspace,
                launcher,
                profile,
                ticket: buildTicket(mutant),
                hint: repair.hint,
                model: options.model ?? "gpt-6.1-terra",
                effort: options.effort ?? "low",
                logFile,
                budgetMs: HARD_BUDGET_MS,
              },
              combined,
              repair.event,
            );
            return active;
          },
          async close() {
            if (closed) return;
            closed = true;
            closing.abort();
            await active?.catch(() => {});
            await workspace.cleanup();
          },
        };
      } catch (error) {
        await workspace.cleanup();
        throw error;
      }
    },
  };
}
