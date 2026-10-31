import { describe, expect, it, vi } from "vitest";
import { parseRoundEnvelope } from "../../../apps/overlay/src/bridge.js";
import {
  initialBroadcast,
  reduceBroadcast,
} from "../../../apps/overlay/src/events.js";
import {
  availableDarwinBytes,
  BOSS_MINIMUM_FREE_BYTES,
  bossAllowed,
  bossMemory,
  newBossReceipt,
  raceBoss,
} from "../src/boss.js";
import type {
  GameArtifact,
  PreparedGame,
  RoundEvent,
  RuntimeObservation,
} from "../src/contracts.js";
import { validBossReceipt } from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { LiveRoundController } from "../src/live.js";
import { publicReceipt } from "../src/receipt.js";

const memory = {
  freeBytes: BOSS_MINIMUM_FREE_BYTES,
  rssBytes: 42,
  minimumFreeBytes: BOSS_MINIMUM_FREE_BYTES,
  measuredAtMs: 100,
};
const patch = { added: 1, removed: 1, preview: ["- bad", "+ good"] };
const timings = {
  threadStartedAtMs: 1,
  patchReadyAtMs: 2,
  validationStartedAtMs: 3,
  validationFinishedAtMs: 4,
};
const artifact: GameArtifact = {
  id: "a",
  digest: "a",
  code: "validated",
  patch: { added: 1, removed: 1, preview: ["- bad", "+ good"] },
  timings: {
    threadStartedAtMs: 1,
    patchReadyAtMs: 2,
    validationStartedAtMs: 3,
    validationFinishedAtMs: 4,
  },
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

describe("boss race over verified artifacts", () => {
  it("guards both result records and rejects malformed or invented winners", () => {
    const record = {
      winner: "terra",
      memory,
      threads: [
        { model: "terra", status: "validated", timings, patch, failure: null },
        {
          model: "sol",
          status: "failed",
          timings: { threadStartedAtMs: 1 },
          patch: null,
          failure: "repair-failed",
        },
      ],
    };
    expect(validBossReceipt(record)).toBe(true);
    expect(validBossReceipt({ winner: null, memory, threads: [] }, true)).toBe(
      true,
    );
    expect(validBossReceipt({ winner: null, memory, threads: [] })).toBe(false);
    expect(validBossReceipt({ ...record, threads: [null, null] })).toBe(false);
    expect(validBossReceipt({ ...record, winner: "sol" })).toBe(false);
    expect(
      validBossReceipt({
        ...record,
        threads: [{ ...record.threads[0], timings: {} }, record.threads[1]],
      }),
    ).toBe(false);
  });
  it("counts measured Darwin reclaimable pages without counting compressed memory", () => {
    expect(
      availableDarwinBytes(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\nPages occupied by compressor: 999.",
      ),
    ).toBe(6 * 16384);
    expect(() => availableDarwinBytes("Pages free: 1.")).toThrow("Incomplete");
  });
  it("measures real free memory and parent RSS, and refuses insufficient or invalid measurements", () => {
    const actual = bossMemory();
    expect(actual.freeBytes).toBeGreaterThan(0);
    expect(actual.rssBytes).toBeGreaterThan(0);
    expect(bossAllowed(memory)).toBe(true);
    expect(bossAllowed({ ...memory, freeBytes: memory.freeBytes - 1 })).toBe(
      false,
    );
    expect(bossAllowed({ ...memory, minimumFreeBytes: 0 })).toBe(false);
    expect(bossAllowed({ ...memory, rssBytes: NaN })).toBe(false);
    expect(
      bossAllowed({ ...memory, measurementError: "vm-stat-unavailable" }),
    ).toBe(false);
  });
  it("dispatches both threads in one turn, returns the first validated artifact, and keeps the loser diff", async () => {
    const slow = deferred<GameArtifact>();
    const report = newBossReceipt(memory);
    const calls: string[] = [];
    const race = raceBoss({
      receipt: report,
      start: async (model, observe) => {
        calls.push(model);
        observe({
          type: "runtime.phase",
          phase: "thread-started",
          atMs: 1,
          wallTime: "test",
        });
        observe({
          type: "runtime.patch",
          atMs: 2,
          wallTime: "test",
          patch: patch,
        });
        return model === "sol" ? slow.promise : artifact;
      },
    });
    expect(await race.winner).toBe(artifact);
    expect(calls).toEqual(["terra", "sol"]);
    expect(report.winner).toBe("terra");
    expect(report.threads[1]?.patch).toEqual(artifact.patch);
    let settled = false;
    void race.settled.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    slow.resolve({ ...artifact, id: "alternate" });
    await race.settled;
    expect(report.threads.map((r) => r.status)).toEqual([
      "validated",
      "validated",
    ]);
  });
  it("does not let a failed model win, and records its observed patch without remote error text", async () => {
    const report = newBossReceipt(memory);
    const race = raceBoss({
      receipt: report,
      start: async (model, observe) => {
        observe({
          type: "runtime.phase",
          phase: "thread-started",
          atMs: 1,
          wallTime: "test",
        });
        observe({
          type: "runtime.patch",
          atMs: 2,
          wallTime: "test",
          patch: patch,
        });
        if (model === "terra") throw new Error("private error");
        return artifact;
      },
    });
    await race.winner;
    await race.settled;
    expect(report.winner).toBe("sol");
    expect(report.threads[0]?.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("private error");
    expect(report.threads[0]?.patch).toEqual(artifact.patch);
  });
  it("rejects skewed actual SDK start observations before an artifact can win", async () => {
    const race = raceBoss({
      receipt: newBossReceipt(memory),
      start: async (model, observe) => {
        observe({
          type: "runtime.phase",
          phase: "thread-started",
          atMs: model === "terra" ? 0 : 1001,
          wallTime: "test",
        });
        return {
          ...artifact,
          timings: {
            ...timings,
            threadStartedAtMs: model === "terra" ? 0 : 1001,
          },
        };
      },
    });
    await expect(race.winner).rejects.toThrow("one second");
    await race.settled;
  });
  it("blocks a fast artifact until both actual starts arrive and refuses a missing or late start", async () => {
    vi.useFakeTimers();
    try {
      const slow = deferred<GameArtifact>();
      let lateObserve: ((event: RuntimeObservation) => void) | undefined;
      const report = newBossReceipt(memory);
      const race = raceBoss({
        receipt: report,
        start: async (model, observe) => {
          if (model === "terra") {
            observe({
              type: "runtime.phase",
              phase: "thread-started",
              atMs: 0,
              wallTime: "test",
            });
            return artifact;
          }
          lateObserve = observe;
          return slow.promise;
        },
      });
      let won = false;
      void race.winner.then(
        () => {
          won = true;
        },
        () => {},
      );
      const refused = expect(race.winner).rejects.toThrow("one second");
      await vi.advanceTimersByTimeAsync(1001);
      expect(won).toBe(false);
      expect(report.winner).toBeNull();
      await refused;
      lateObserve?.({
        type: "runtime.phase",
        phase: "thread-started",
        atMs: 1001,
        wallTime: "test",
      });
      slow.resolve(artifact);
      await race.settled;
      expect(report.winner).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses the boss before preparing a workspace and publishes an honest low-memory note", async () => {
    const prepare = vi.fn();
    const events: RoundEvent[] = [];
    const engine = new RoundEngine({
      runtime: { prepare },
      activate: async () => {},
      publish: (event) => events.push(event),
      boss: { inspectMemory: () => ({ ...memory, freeBytes: 0 }) },
    });
    engine.requestBoss("broadcaster");
    expect(prepare).not.toHaveBeenCalled();
    expect(engine.snapshot().active).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "round.boss-memory", accepted: false }),
        expect.objectContaining({
          event: { type: "boss.note", text: "BOSS PAUSED · LOW MEMORY" },
        }),
      ]),
    );
    await engine.stop();
  });
  it("installs only the winner immediately, keeps input, freezes GREEN, and records both threads after loser settlement", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const loser = deferred<void>();
      let report = newBossReceipt(memory);
      const installs: string[] = [];
      const events: RoundEvent[] = [];
      let lateSdk: (() => void) | undefined;
      const lines: string[] = [];
      const clip = vi.fn(async () => ({
        id: "fixture",
        url: "https://clips.twitch.tv/fixture",
        titlePath: "accepted" as const,
      }));
      const controller = new LiveRoundController({
        broadcasterId: "fixture-channel",
        botUserId: "fixture-channel",
        identify: () => "viewer-0123456789abcdef",
        record: () => {},
        helix: {
          isLive: async () => true,
          chat: async (line) => {
            lines.push(line);
            return `reply-${lines.length}`;
          },
          marker: async () => {},
          pin: async () => {},
          clip,
        },
      });
      const game: PreparedGame = {
        family: "gravity-sign",
        clean: artifact,
        broken: { ...artifact, id: "broken" },
        repair: vi.fn(async () => {
          throw new Error("single runner must not run");
        }),
        close: async () => {},
        repairBoss: async (options) => {
          lateSdk = () =>
            options.event(
              {
                type: "item.completed",
                item: {
                  id: "loser-read",
                  type: "command_execution",
                  command: "cat src/index.ts",
                  aggregated_output: "",
                  exit_code: 0,
                  status: "completed",
                },
              },
              "sol",
            );
          report.winner = "terra";
          report.threads = [
            {
              model: "terra",
              status: "validated",
              timings: timings,
              patch: patch,
              failure: null,
            },
            {
              model: "sol",
              status: "failed",
              timings: { threadStartedAtMs: 1 },
              patch: null,
              failure: "repair-failed",
            },
          ];
          now = 10;
          return artifact;
        },
        settleBoss: () => loser.promise,
      };
      const engine = new RoundEngine({
        headStartMs: 1,
        now: () => now,
        boss: { every: 1, inspectMemory: () => memory },
        runtime: {
          prepare: async (_id, _signal, _family, boss) => {
            if (!boss) throw new Error("Missing boss receipt");
            report = boss;
            game.boss = boss;
            return game;
          },
        },
        activate: async (build) => {
          installs.push(build.id);
        },
        publish: (event) => {
          events.push(event);
          controller.observe(event);
        },
      });
      engine.handlePublic({
        kind: "break-requested",
        source: "power-up",
        actor: "viewer",
        bugCount: 1,
        severity: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(installs).toEqual(["broken", "a"]);
      expect(engine.snapshot().active).toBe(true);
      expect(engine.snapshot().phase).toBe("resolved");
      expect(engine.snapshot().scores.codex).toBe(1);
      expect(
        events.filter(
          (event) =>
            event.type === "overlay" && event.event.type === "tests.green",
        ),
      ).toHaveLength(1);
      await controller.flush();
      expect(clip).toHaveBeenCalledOnce();
      expect(lines.filter((line) => line.startsWith("Codex fixed"))).toEqual([
        "Codex fixed gravity-sign. GREEN 0:00.01",
      ]);
      expect(lines.some((line) => line.includes("+1 test"))).toBe(false);
      expect(engine.snapshot().autopsy).toBeNull();
      lateSdk?.();
      expect(
        events.some(
          (event) =>
            event.type === "overlay" &&
            event.event.type === "codex.step" &&
            event.event.model === "sol",
        ),
      ).toBe(true);
      now = 1000;
      loser.resolve();
      await engine.waitForRound();
      expect(engine.snapshot().autopsy?.input).toBe("power-up");
      expect(engine.snapshot().autopsy?.durations.timeToGreenMs).toBe(9);
      expect(engine.snapshot().autopsy?.boss?.threads).toHaveLength(2);
      Object.assign(report, { privateUser: "private-boss-user" });
      const receipt = publicReceipt({
        result: engine.snapshot(),
        breaker:
          engine.snapshot().autopsy?.breaker ?? "viewer-0123456789abcdef",
        events: [],
        client: {
          frame: 100,
          hash: "00000000",
          alive: true,
          won: false,
          buildId: "a".repeat(64),
          sdkSteps: 0,
          installs: [
            { buildId: "b".repeat(64), frame: 1, statePreserved: true },
            { buildId: "a".repeat(64), frame: 2, statePreserved: true },
          ],
          broadcast: {
            ...initialBroadcast(),
            bug: "fixed",
            bugName: "gravity-sign",
          },
        },
      });
      expect(receipt.autopsy?.boss?.threads).toHaveLength(2);
      expect(receipt.input).toBe("power-up");
      expect(JSON.stringify(receipt)).not.toContain("private-boss-user");
      expect(engine.snapshot().scores.codex).toBe(1);
      expect(
        events.filter(
          (event) =>
            event.type === "overlay" && event.event.type === "tests.green",
        ),
      ).toHaveLength(1);
      await controller.flush();
      expect(clip).toHaveBeenCalledOnce();
      expect(
        lines.filter((line) => line.startsWith("Codex fixed")),
      ).toHaveLength(1);
      await controller.close();
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps model ticker rows and predictions separate without fabricating test success", () => {
    let state = reduceBroadcast(initialBroadcast(), {
      type: "round.started",
      id: "r",
      number: 1,
      atMs: 0,
    });
    state = reduceBroadcast(state, { type: "boss.started", roundId: "r" });
    state = reduceBroadcast(state, {
      type: "codex.step",
      model: "sol",
      roundId: "r",
      id: "read",
      step: { kind: "reading", path: "src/index.ts" },
      status: "done",
      attempt: 1,
      total: 1,
    });
    expect(state.boss?.sol[0]?.label).toBe("Reading index.ts");
    expect(state.boss?.terra).toEqual([]);
    expect(state.bug).not.toBe("fixed");
    state = reduceBroadcast(state, {
      type: "boss.predictions",
      roundId: "r",
      sol: 2,
      terra: 3,
    });
    expect(state.boss?.predictions).toEqual({ sol: 2, terra: 3 });
    expect(
      parseRoundEnvelope({
        sequence: 1,
        serverTimeMs: 0,
        event: {
          type: "overlay",
          event: { type: "boss.started", roundId: "r" },
        },
      }).event.type,
    ).toBe("overlay");
  });
});
