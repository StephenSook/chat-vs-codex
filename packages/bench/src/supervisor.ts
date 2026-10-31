import { type ChildProcess, fork } from "node:child_process";
import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT } from "../../mutator/src/gate.js";
import type { TrialResult } from "./statistics.js";
import { HARD_BUDGET_MS, type TrialOptions } from "./trial.js";
import { inspectChanges, type Snapshot } from "./workspace.js";

export function armHardDeadline(
  child: Pick<ChildProcess, "pid" | "kill">,
  milliseconds: number,
  expired: () => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    expired();
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, milliseconds);
}

/** Separate process group makes the wall-clock deadline independent of blocked JS or I/O. */
export async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const child = fork(join(ROOT, "packages/bench/src/worker.ts"), [], {
    cwd: ROOT,
    execArgv: ["--import", "tsx"],
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const path = join(options.runsDirectory, `${options.trialId}.jsonl`);
  let game: string | null = null;
  let home: string | null = null;
  let startedAt = new Date().toISOString();
  let before: Snapshot | undefined;
  let runtimeStarted: number | undefined;
  let hardExpired = false;
  let error = "Worker exited without a completed result";
  let result: TrialResult | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const capture: Promise<void>[] = [];
  for (const [name, stream] of [
    ["worker.stdout", child.stdout],
    ["worker.stderr", child.stderr],
  ] as const) {
    stream?.on("data", (bytes: Buffer) => {
      capture.push(
        appendFile(
          path,
          `${JSON.stringify({ timestamp: new Date().toISOString(), kind: name, text: bytes.toString() })}\n`,
        ),
      );
    });
  }
  // Preparation is separate from measured runtime; it also has a finite resource bound.
  timer = armHardDeadline(child, 120000, () => {
    error = "Workspace preparation exceeded 120 seconds";
  });
  await new Promise<void>((resolve) => {
    child.on(
      "message",
      (raw: {
        type?: string;
        game?: string;
        home?: string;
        startedAt?: string;
        before?: Snapshot;
        result?: TrialResult;
        error?: string;
      }) => {
        if (raw.type === "started") {
          game = raw.game ?? null;
          home = raw.home ?? null;
          startedAt = raw.startedAt ?? startedAt;
          before = raw.before;
          runtimeStarted = performance.now();
          clearTimeout(timer);
          timer = armHardDeadline(child, HARD_BUDGET_MS, () => {
            hardExpired = true;
            error = "Hard trial budget expired; worker process group killed";
          });
        }
        if (raw.type === "result") result = raw.result;
        if (raw.type === "error") error = raw.error ?? error;
      },
    );
    child.once("error", (event) => {
      error = event.message;
      resolve();
    });
    child.once("exit", () => resolve());
    child.send(options);
  });
  clearTimeout(timer);
  await Promise.all(capture);
  if (result && !hardExpired) return result;
  const fallback: TrialResult = {
    schemaVersion: 1,
    ...options,
    mutantId: options.mutant.id,
    family: options.mutant.family,
    status: "loss",
    timeToGreenMs: null,
    elapsedMs:
      runtimeStarted === undefined ? 0 : performance.now() - runtimeStarted,
    exactRevert: false,
    filesChanged: [],
    linesChanged: 0,
    usage: null,
    failureReason: error,
    startedAt,
    answer: null,
  };
  // Remove input-only metadata before strict result parsing or persistence.
  const row: TrialResult = {
    schemaVersion: fallback.schemaVersion,
    trialId: fallback.trialId,
    batchId: fallback.batchId,
    mutantId: fallback.mutantId,
    family: fallback.family,
    model: fallback.model,
    effort: fallback.effort,
    status: fallback.status,
    timeToGreenMs: null,
    elapsedMs: fallback.elapsedMs,
    exactRevert: false,
    filesChanged: [],
    linesChanged: 0,
    usage: null,
    failureReason: error,
    dryRun: fallback.dryRun,
    sourceDigest: fallback.sourceDigest,
    startedAt,
    answer: null,
  };
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const event = JSON.parse(line) as {
          event?: { type: string; usage?: TrialResult["usage"] };
          kind?: string;
        };
        if (event.event?.type === "turn.completed" && event.event.usage) {
          const u = event.event.usage;
          row.usage = {
            input_tokens: u.input_tokens,
            cached_input_tokens: u.cached_input_tokens,
            output_tokens: u.output_tokens,
          };
        }
      } catch {
        /* A killed append may leave one incomplete trailing event. Retain the raw file. */
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (game && before) {
    try {
      Object.assign(row, await inspectChanges(game, before));
    } catch (error) {
      row.failureReason += `; postmortem inspection failed: ${error}`;
    }
  }
  await appendFile(
    path,
    `${JSON.stringify({ timestamp: new Date().toISOString(), kind: "supervisor.result", result: row })}\n`,
  );
  if (game) await rm(join(game, ".."), { recursive: true, force: true });
  if (home) await rm(home, { recursive: true, force: true });
  return row;
}
