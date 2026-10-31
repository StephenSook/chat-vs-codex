import { execFileSync } from "node:child_process";
import { freemem } from "node:os";
import { monotonicMs } from "./clocks.js";
import type {
  BossModel,
  BossReceipt,
  BossThreadResult,
  GameArtifact,
  RuntimeObservation,
} from "./contracts.js";

export const BOSS_MINIMUM_FREE_BYTES = 1536 * 1024 * 1024;
export function availableDarwinBytes(output: string): number {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const pages = ["free", "inactive", "speculative"].map(
    (name) => new RegExp(`Pages ${name}:\\s+(\\d+)\\.`).exec(output)?.[1],
  );
  if (!pageSize || pages.some((count) => count === undefined))
    throw new Error("Incomplete vm_stat measurement");
  const result =
    Number(pageSize) * pages.reduce((sum, count) => sum + Number(count), 0);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid vm_stat measurement");
  return result;
}
export function bossMemory(): BossReceipt["memory"] {
  const freeBytes = freemem();
  let availableBytes: number | undefined = freeBytes;
  let measurementError: "vm-stat-unavailable" | undefined;
  if (process.platform === "darwin") {
    try {
      availableBytes = availableDarwinBytes(
        execFileSync("/usr/bin/vm_stat", [], {
          encoding: "utf8",
          timeout: 1000,
          maxBuffer: 16384,
        }),
      );
    } catch {
      availableBytes = undefined;
      measurementError = "vm-stat-unavailable";
    }
  }
  return {
    freeBytes,
    ...(availableBytes === undefined ? {} : { availableBytes }),
    ...(measurementError === undefined ? {} : { measurementError }),
    rssBytes: process.memoryUsage().rss,
    minimumFreeBytes: BOSS_MINIMUM_FREE_BYTES,
    measuredAtMs: monotonicMs(),
  };
}
export function bossAllowed(memory: BossReceipt["memory"]): boolean {
  return (
    memory.measurementError === undefined &&
    Object.values(memory).every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    ) &&
    memory.rssBytes >= 0 &&
    (memory.availableBytes ?? memory.freeBytes) >= memory.minimumFreeBytes &&
    memory.minimumFreeBytes >= BOSS_MINIMUM_FREE_BYTES
  );
}
export function newBossReceipt(memory: BossReceipt["memory"]): BossReceipt {
  return { winner: null, memory, threads: [] };
}
/** Starts both already-prepared SDK workers in the same turn. The first successful
 * resolution is a fully validated artifact, never an SDK claim. Both are retained. */
export function raceBoss(options: {
  receipt: BossReceipt;
  start(
    model: BossModel,
    observe: (event: RuntimeObservation) => void,
  ): Promise<GameArtifact>;
}): { winner: Promise<GameArtifact>; settled: Promise<void> } {
  const models: BossModel[] = ["terra", "sol"];
  const starts = new Map<BossModel, number>();
  let resolveStarts!: () => void;
  let rejectStarts!: (reason: unknown) => void;
  let startsFinished = false;
  let secondStartTimer: ReturnType<typeof setTimeout> | undefined;
  // Worker startup may precede the first SDK call. Once either SDK starts,
  // the other must report its actual start within one second.
  const bothStarted = new Promise<void>((resolve, reject) => {
    resolveStarts = resolve;
    rejectStarts = reject;
  });
  const firstStartTimer = setTimeout(
    () => finishStarts(new Error("Boss SDK start was not observed")),
    5000,
  );
  function finishStarts(error?: unknown) {
    if (startsFinished) return;
    startsFinished = true;
    clearTimeout(firstStartTimer);
    if (secondStartTimer) clearTimeout(secondStartTimer);
    if (error === undefined) resolveStarts();
    else rejectStarts(error);
  }
  function started(model: BossModel, atMs: number) {
    if (startsFinished || starts.has(model)) return;
    if (!Number.isFinite(atMs) || atMs < 0) {
      finishStarts(new Error("Invalid boss SDK start"));
      return;
    }
    starts.set(model, atMs);
    if (starts.size === 1) {
      clearTimeout(firstStartTimer);
      secondStartTimer = setTimeout(
        () =>
          finishStarts(
            new Error("Boss SDK threads did not start within one second"),
          ),
        1000,
      );
    } else {
      const times = [...starts.values()];
      finishStarts(
        Math.max(...times) - Math.min(...times) <= 1000
          ? undefined
          : new Error("Boss SDK threads did not start within one second"),
      );
    }
  }
  const outcomes = models.map((model) => {
    const result: BossThreadResult = {
      model,
      status: "failed",
      timings: {},
      patch: null,
      failure: "repair-failed",
    };
    options.receipt.threads.push(result);
    const observe = (event: RuntimeObservation) => {
      if (event.type === "runtime.patch") result.patch = event.patch;
      if (event.type === "runtime.phase") {
        const key = {
          "thread-started": "threadStartedAtMs",
          "patch-ready": "patchReadyAtMs",
          "validation-started": "validationStartedAtMs",
          "validation-passed": "validationFinishedAtMs",
        } as const;
        result.timings[key[event.phase]] = event.atMs;
        if (event.phase === "thread-started") started(model, event.atMs);
      }
    };
    return Promise.resolve()
      .then(() => options.start(model, observe))
      .then((artifact) => {
        result.status = "validated";
        result.failure = null;
        result.timings = artifact.timings ?? result.timings;
        result.patch = artifact.patch ?? result.patch;
        return { artifact, model };
      });
  });
  // Subscribe immediately, preserving the actual first validation even when
  // both artifacts arrive before IPC has delivered the second start observation.
  const firstValidated = Promise.any(outcomes);
  void firstValidated.catch((error: unknown) => finishStarts(error));
  const winner = bothStarted
    .then(() => firstValidated)
    .then(({ artifact, model }) => {
      options.receipt.winner = model;
      return artifact;
    });
  const settled = Promise.allSettled(outcomes).then(() => {});
  void winner.catch(() => {});
  void settled.catch(() => {});
  return { winner, settled };
}
