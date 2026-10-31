import type { ThreadEvent } from "@openai/codex-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GameArtifact,
  PreparedGame,
  PreviousVerifiedRound,
  RoundEvent,
  RuntimePhaseObservation,
} from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { sdkOverlayEvent } from "../src/sdk-events.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const clean: GameArtifact = {
  id: "clean",
  code: "clean source",
  digest: "clean-digest",
};
const broken: GameArtifact = {
  id: "broken",
  code: "broken source",
  digest: "broken-digest",
};
const repaired: GameArtifact = {
  id: "repaired",
  code: "validated repair",
  digest: "repair-digest",
};
const engines: RoundEngine[] = [];
function setup(
  overrides: {
    activate?: (
      artifact: GameArtifact,
      phase: "broken" | "repaired" | "rollback",
      id: string,
      signal: AbortSignal,
    ) => Promise<void>;
    prepare?: (id: string, signal: AbortSignal) => Promise<PreparedGame>;
    headStartMs?: number;
    identify?: (actor: string) => string | null;
    previousRound?: PreviousVerifiedRound;
  } = {},
) {
  const repair = deferred<GameArtifact>();
  const close = vi.fn(async () => {});
  const game: PreparedGame = {
    family: "gravity-sign",
    clean,
    broken,
    repair: vi.fn(async () => repair.promise),
    close,
  };
  const prepare = vi.fn(overrides.prepare ?? (async () => game));
  const activate = vi.fn(overrides.activate ?? (async () => {}));
  const events: RoundEvent[] = [];
  const engine = new RoundEngine({
    now: () => Date.now(),
    runtime: { prepare },
    activate,
    publish: (event) => events.push(event),
    ...(overrides.identify ? { identify: overrides.identify } : {}),
    ...(overrides.previousRound
      ? { previousRound: overrides.previousRound }
      : {}),
    ...(overrides.headStartMs === undefined
      ? {}
      : { headStartMs: overrides.headStartMs }),
  });
  engines.push(engine);
  return { engine, events, game, prepare, repair, activate, close };
}
function breakGame(engine: RoundEngine, count: 1 | 2 = 1) {
  engine.handlePublic({
    kind: "break-requested",
    source: "chat",
    actor: "viewer",
    bugCount: count,
    severity: 1,
  });
}
function guess(engine: RoundEngine, actor: string, word: string) {
  engine.handlePublic({ kind: "guess-submitted", actor, word });
}
function sdk(
  command: string,
  status: "in_progress" | "completed" | "failed" = "in_progress",
  output = "",
  exitCode?: number,
): ThreadEvent {
  return {
    type: status === "in_progress" ? "item.started" : "item.completed",
    item: {
      type: "command_execution",
      id: "command-1",
      command,
      status,
      aggregated_output: output,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  vi.useRealTimers();
});

describe("round race and safe swaps", () => {
  it("publishes actual patch observations as separate counted steps without claiming tests green", async () => {
    const { engine, game, events, repair } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    const observe = vi.mocked(game.repair).mock.calls[0]?.[0].observe;
    if (!observe) throw new Error("Missing observation callback");
    observe({
      type: "runtime.patch",
      patch: {
        added: 7,
        removed: 3,
        preview: ["-private old source", "+private new source"],
      },
      atMs: Date.now(),
      wallTime: new Date().toISOString(),
    });
    observe({
      type: "runtime.patch",
      patch: { added: 8, removed: 3, preview: ["+next edit"] },
      atMs: Date.now(),
      wallTime: new Date().toISOString(),
    });
    expect(
      events.filter(
        (event) =>
          event.type === "overlay" && event.event.type === "codex.step",
      ),
    ).toMatchObject([
      {
        event: {
          id: "patch-1",
          step: { kind: "patch", added: 7, removed: 3 },
          status: "done",
        },
      },
      {
        event: {
          id: "patch-2",
          step: { kind: "patch", added: 8, removed: 3 },
          status: "done",
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private old source");
    expect(
      events.some(
        (event) =>
          event.type === "overlay" && event.event.type === "tests.green",
      ),
    ).toBe(false);
    repair.resolve(repaired);
    await engine.waitForRound();
    const count = events.length;
    observe({
      type: "runtime.patch",
      patch: { added: 99, removed: 99, preview: [] },
      atMs: Date.now(),
      wallTime: new Date().toISOString(),
    });
    expect(events).toHaveLength(count);
  });

  it("measures observed repair, verification and swap separately, excluding head start from time to green", async () => {
    const installed = deferred<void>();
    const { engine, game, repair, events } = setup({
      activate: async (_artifact, phase) => {
        if (phase === "repaired") await installed.promise;
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    const options = vi.mocked(game.repair).mock.calls[0]?.[0];
    if (!options?.observe)
      throw new Error("Missing runtime observation callback");
    const observed = (phase: RuntimePhaseObservation["phase"]) =>
      options.observe?.({
        type: "runtime.phase",
        phase,
        atMs: Date.now(),
        wallTime: new Date().toISOString(),
      });
    await vi.advanceTimersByTimeAsync(10);
    observed("thread-started");
    await vi.advanceTimersByTimeAsync(3000);
    observed("patch-ready");
    await vi.advanceTimersByTimeAsync(100);
    observed("validation-started");
    expect(engine.snapshot().phase).toBe("validating");
    expect(engine.snapshot().durations).toMatchObject({
      repairMs: 3000,
      validationMs: null,
      timeToGreenMs: null,
    });
    await vi.advanceTimersByTimeAsync(500);
    observed("validation-passed");
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.snapshot().phase).toBe("swapping");
    await vi.advanceTimersByTimeAsync(80);
    installed.resolve();
    const result = await engine.waitForRound();
    expect(result.durations).toEqual({
      headStartMs: 15000,
      repairMs: 3000,
      validationMs: 500,
      swapMs: 80,
      timeToGreenMs: 3680,
    });
    for (const event of events) {
      expect(Number.isFinite(event.atMs)).toBe(true);
      expect(Number.isFinite(Date.parse(event.wallTime ?? ""))).toBe(true);
    }
    const count = events.length;
    observed("validation-started");
    expect(events).toHaveLength(count);
  });

  it("leaves unobserved runtime latencies unknown instead of reporting invented durations", async () => {
    const { engine, repair } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15000);
    repair.resolve(repaired);
    const result = await engine.waitForRound();
    expect(result.durations).toEqual({
      headStartMs: 15000,
      repairMs: null,
      validationMs: null,
      swapMs: 0,
      timeToGreenMs: null,
    });
  });

  it("uses a monotonic default clock even when the wall clock changes", async () => {
    const events: RoundEvent[] = [];
    const game: PreparedGame = {
      family: "gravity-sign",
      clean,
      broken,
      repair: async () => repaired,
      close: async () => {},
    };
    const engine = new RoundEngine({
      runtime: { prepare: async () => game },
      headStartMs: 0,
      publish: (event) => events.push(event),
      activate: async () => {
        vi.setSystemTime(Date.now() + 1000000);
      },
    });
    engines.push(engine);
    breakGame(engine);
    await engine.waitForRound();
    const started = events.find(
      (event) =>
        event.type === "overlay" && event.event.type === "round.started",
    );
    if (started?.type !== "overlay" || started.event.type !== "round.started")
      throw new Error("Missing round start");
    expect(started.event.atMs).toBeLessThan(1000);
    expect(engine.snapshot().winner).toBe("codex");
  });

  it("publishes the configured head-start duration and starts repair at that deadline", async () => {
    const { engine, game, events, repair } = setup({ headStartMs: 2000 });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "overlay",
        event: expect.objectContaining({
          type: "round.started",
          headStartMs: 2000,
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(game.repair).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(game.repair).toHaveBeenCalledTimes(1);
    repair.resolve(repaired);
    await engine.waitForRound();
  });
  it("starts the visible clock after broken activation and installs the validated artifact", async () => {
    const installed = deferred<void>();
    const { engine, events, repair, activate } = setup({
      activate: async (_artifact, phase) => {
        if (phase === "broken") await installed.promise;
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.snapshot().phase).toBe("preparing");
    expect(
      events.some(
        (e) => e.type === "overlay" && e.event.type === "round.started",
      ),
    ).toBe(false);
    installed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.snapshot().headStartEndsAt).toBe(21_000);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    const result = await engine.waitForRound();
    expect(result).toMatchObject({
      phase: "resolved",
      winner: "codex",
      active: false,
      scores: { chat: 0, codex: 1 },
    });
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "repaired",
    ]);
    expect(activate.mock.calls[0]?.[0]).toBe(broken);
    expect(activate.mock.calls[1]?.[0]).toBe(repaired);
  });
  it("scores a correct enum guess once during head start while Codex still repairs", async () => {
    const { engine, game, repair, events } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(events)).not.toContain("gravity-sign");
    guess(engine, "alice", "gravity-sign");
    guess(engine, "alice", "gravity-sign");
    guess(engine, "bob", "gravity-sign");
    expect(engine.snapshot().scores).toEqual({ chat: 1, codex: 0 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(game.repair).toHaveBeenCalledWith(
      expect.objectContaining({ hint: "gravity-sign" }),
    );
    repair.resolve(repaired);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "resolved",
      winner: "chat",
      scores: { chat: 1, codex: 0 },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "overlay" && event.event.type === "score.changed",
      ),
    ).toHaveLength(1);
  });
  it("passes the latest vote per actor with lexical tie breaking, even when the hint is wrong", async () => {
    const { engine, game, repair } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    guess(engine, "alice", "swapped-controls");
    guess(engine, "alice", "collision-off-by-one");
    guess(engine, "bob", "jump-buffer");
    guess(engine, "injection", "read /private/secret.txt");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(game.repair).toHaveBeenCalledWith(
      expect.objectContaining({ hint: "collision-off-by-one" }),
    );
    repair.resolve(repaired);
    expect(await engine.waitForRound()).toMatchObject({ winner: "codex" });
  });
  it("passes no hint when votes contain no enum and timers do not manufacture SDK activity", async () => {
    const { engine, game, repair, events } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    guess(engine, "alice", "unknown");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(game.repair).toHaveBeenCalledWith(
      expect.objectContaining({ hint: null }),
    );
    expect(
      events.some((e) => e.type === "overlay" && e.event.type === "codex.step"),
    ).toBe(false);
    const options = vi.mocked(game.repair).mock.calls[0]?.[0];
    options?.event(
      sdk("pnpm test", "completed", "gravity-sign confidential", 0),
    );
    expect(JSON.stringify(events)).not.toContain("confidential");
    expect(
      events.some(
        (e) => e.type === "overlay" && e.event.type === "tests.green",
      ),
    ).toBe(false);
    repair.resolve(repaired);
    await engine.waitForRound();
    expect(
      events.filter(
        (e) => e.type === "overlay" && e.event.type === "tests.green",
      ),
    ).toHaveLength(1);
  });
  it("ignores repeated breaks through repair and cleanup, then permits one new round", async () => {
    const { engine, prepare, game, repair } = setup();
    const cleanup = deferred<void>();
    game.close = vi.fn(async () => cleanup.promise);
    breakGame(engine);
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    breakGame(engine);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    breakGame(engine);
    expect(prepare).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await engine.waitForRound();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it("closes guesses at 60 seconds while permitting a validated repair without a race point", async () => {
    const { engine, repair } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(60_000);
    guess(engine, "late", "gravity-sign");
    expect(engine.snapshot().winner).toBeNull();
    repair.resolve(repaired);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "resolved",
      winner: null,
      reason: "round-limit",
      scores: { chat: 0, codex: 0 },
    });
  });
  it("declines unsupported multi-bug requests and private selections without revealing a family", () => {
    const { engine, prepare, events } = setup();
    breakGame(engine, 2);
    expect(prepare).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ reason: "unsupported-bug-count" }),
    );
    expect(
      engine.handlePrivate({
        kind: "sabotage-selected",
        actor: "secret",
        family: "gravity-sign",
      }),
    ).toEqual({ accepted: false, reason: "private-selection-unavailable" });
    expect(JSON.stringify(events)).not.toContain("gravity-sign");
  });
});

describe("terminal round autopsy", () => {
  it("keeps the first correct hashed viewer separate from the winner and publishes only after cleanup", async () => {
    const cleanup = deferred<void>();
    const alice = "viewer-aaaaaaaaaaaaaaaa";
    const context = setup({
      identify: (actor) =>
        actor === "alice" ? alice : "viewer-bbbbbbbbbbbbbbbb",
      previousRound: { roundId: "prior", timeToGreenMs: 1000 },
    });
    context.game.close = async () => cleanup.promise;
    breakGame(context.engine);
    await vi.advanceTimersByTimeAsync(15000);
    guess(context.engine, "alice", "gravity-sign");
    guess(context.engine, "bob", "gravity-sign");
    await vi.advanceTimersByTimeAsync(600);
    const patch = { added: 1, removed: 1, preview: ["-old", "+new"] };
    context.repair.resolve({
      ...repaired,
      patch,
      diagnosis: {
        rootCause: "actual cause",
        file: "src/index.ts",
        line: 1,
        explanation: "Restore downward\n acceleration.",
        confidence: 1,
      },
      timings: {
        threadStartedAtMs: 16000,
        patchReadyAtMs: 16500,
        validationStartedAtMs: 16500,
        validationFinishedAtMs: 16600,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      context.events.some(
        (event) =>
          event.type === "overlay" && event.event.type === "round.autopsy",
      ),
    ).toBe(false);
    expect(
      context.events.some(
        (event) =>
          event.type === "overlay" && event.event.type === "tests.green",
      ),
    ).toBe(false);
    cleanup.resolve();
    const result = await context.engine.waitForRound();
    expect(result.autopsy).toMatchObject({
      status: "verified",
      breaker: "viewer-bbbbbbbbbbbbbbbb",
      firstCorrectGuesser: alice,
      winner: "chat",
      family: "gravity-sign",
      patch,
      explanation: "Restore downward acceleration.",
      previousRoundId: "prior",
      deltaMs: -400,
      durations: { timeToGreenMs: 600 },
    });
    expect(
      context.events.filter(
        (event) =>
          event.type === "overlay" && event.event.type === "round.autopsy",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(context.events)).not.toMatch(/"alice"|"bob"/);
  });

  it("uses ephemeral HMAC labels by default and leaves missing diagnosis, patch and timing unavailable", async () => {
    const { engine, repair } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    guess(engine, "viewer", "gravity-sign");
    await vi.advanceTimersByTimeAsync(15000);
    repair.resolve(repaired);
    const result = await engine.waitForRound();
    expect(result.autopsy?.breaker).toMatch(/^viewer-[a-f0-9]{16}$/);
    expect(result.autopsy?.firstCorrectGuesser).toBe(result.autopsy?.breaker);
    expect(result.autopsy).toMatchObject({
      patch: null,
      explanation: null,
      previousRoundId: null,
      deltaMs: null,
      durations: { timeToGreenMs: null },
    });
  });

  it("refuses raw identity callbacks without replacing an unavailable first guesser with a later one", async () => {
    const { engine, repair } = setup({
      identify: (actor) =>
        actor === "bob" ? "viewer-bbbbbbbbbbbbbbbb" : actor,
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    guess(engine, "alice", "gravity-sign");
    guess(engine, "bob", "gravity-sign");
    await vi.advanceTimersByTimeAsync(15000);
    repair.resolve(repaired);
    expect((await engine.waitForRound()).autopsy).toMatchObject({
      breaker: null,
      firstCorrectGuesser: null,
    });
  });

  it("emits a rollback autopsy without patch, green timing or comparison after failed verification", async () => {
    const { engine, repair, events } = setup({
      previousRound: { roundId: "prior", timeToGreenMs: 1000 },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15000);
    repair.reject(new Error("private failure"));
    expect((await engine.waitForRound()).autopsy).toMatchObject({
      status: "rolled-back",
      reason: "repair-failed",
      patch: null,
      explanation: null,
      deltaMs: null,
      previousRoundId: "prior",
      durations: { timeToGreenMs: null },
    });
    expect(
      events.some(
        (event) =>
          event.type === "overlay" && event.event.type === "tests.green",
      ),
    ).toBe(false);
  });
});

describe("abort and failure boundaries", () => {
  it("rolls back a failed repair and never publishes a green or Codex score", async () => {
    const { engine, repair, events, activate, close } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.reject(new Error("secret gravity-sign details"));
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "repair-failed",
      scores: { chat: 0, codex: 0 },
    });
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "rollback",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(events)).not.toContain("secret gravity-sign details");
    expect(
      events.some(
        (e) => e.type === "overlay" && e.event.type === "tests.green",
      ),
    ).toBe(false);
  });
  it("aborts and rolls back at 240 seconds, ignoring late repair artifacts and SDK callbacks", async () => {
    const { engine, game, repair, activate, events } = setup();
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    const options = vi.mocked(game.repair).mock.calls[0]?.[0];
    await vi.advanceTimersByTimeAsync(225_000);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "hard-budget",
    });
    expect(options?.signal.aborted).toBe(true);
    const count = events.length;
    options?.event(sdk("cat src/physics.ts"));
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(count);
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "rollback",
    ]);
  });
  it("rolls back a failed repaired activation before allowing a subsequent round", async () => {
    const { engine, repair, activate } = setup({
      activate: async (_artifact, phase) => {
        if (phase === "repaired") throw new Error("install failure");
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "activation-failed",
    });
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "repaired",
      "rollback",
    ]);
  });
  it("serializes stop rollback after an in-flight activation and does not score its late success", async () => {
    const swap = deferred<void>();
    const { engine, repair, activate, events } = setup({
      activate: async (_artifact, phase) => {
        if (phase === "repaired") await swap.promise;
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = engine.stop();
    expect(engine.snapshot().scores.codex).toBe(0);
    swap.resolve();
    await stopped;
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "repaired",
      "rollback",
    ]);
    expect(engine.snapshot()).toMatchObject({
      phase: "rolled-back",
      reason: "stopped",
      active: false,
    });
    expect(
      events.some(
        (e) => e.type === "overlay" && e.event.type === "tests.green",
      ),
    ).toBe(false);
  });
  it("closes a late prepared workspace after stop without ever installing it", async () => {
    const pending = deferred<PreparedGame>();
    const { engine, game, activate, close } = setup({
      prepare: async () => pending.promise,
    });
    breakGame(engine);
    await engine.stop();
    pending.resolve(game);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    breakGame(engine);
    expect(engine.snapshot().phase).toBe("rolled-back");
  });
  it("bounds preparation independently and closes its late workspace", async () => {
    const pending = deferred<PreparedGame>();
    const { engine, game, activate, close } = setup({
      prepare: async () => pending.promise,
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "prepare-deadline",
      active: false,
    });
    pending.resolve(game);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
  });
  it("reports rollback failure without clearing the visible corruption or claiming green", async () => {
    const { engine, repair, events } = setup({
      activate: async (_artifact, phase) => {
        if (phase === "rollback") throw new Error("cannot restore");
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.reject(new Error("bad repair"));
    expect(await engine.waitForRound()).toMatchObject({
      reason: "rollback-failed",
      scores: { chat: 0, codex: 0 },
    });
    expect(
      events.some(
        (event) =>
          event.type === "overlay" &&
          (event.event.type === "tests.green" ||
            (event.event.type === "bug.active" && event.event.intensity === 0)),
      ),
    ).toBe(false);
  });
  it("aborts a never-resolving activation at the hard deadline and releases the queue for rollback", async () => {
    let installSignal: AbortSignal | undefined;
    const { engine, repair, activate } = setup({
      activate: async (_artifact, phase, _id, signal) => {
        if (phase === "repaired") {
          installSignal = signal;
          await new Promise<void>(() => {});
        }
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(225_000);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "hard-budget",
      active: false,
    });
    expect(installSignal?.aborted).toBe(true);
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "repaired",
      "rollback",
    ]);
  });
  it("finishes stop before a stale callback resolves, and an abort-aware callback cannot publish late", async () => {
    const delayed = deferred<void>();
    const committed: string[] = [];
    const { engine, repair } = setup({
      activate: async (_artifact, phase, _id, signal) => {
        if (phase === "repaired") await delayed.promise;
        if (!signal.aborted) committed.push(phase);
      },
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(0);
    await engine.stop();
    expect(committed).toEqual(["broken", "rollback"]);
    delayed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(committed).toEqual(["broken", "rollback"]);
  });
  it("bounds rollback after stop even when every installer callback hangs", async () => {
    const { engine, activate } = setup({
      activate: async () => new Promise<void>(() => {}),
    });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = engine.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(engine.snapshot()).toMatchObject({
      reason: "rollback-timeout",
      active: false,
    });
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "rollback",
    ]);
    expect(activate.mock.calls[1]?.[3].aborted).toBe(true);
  });
  it("bounds cleanup and refuses subsequent rounds when cleanup cannot complete", async () => {
    const { engine, game, repair, prepare, events, activate } = setup();
    game.close = vi.fn(async () => new Promise<void>(() => {}));
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "rolled-back",
      reason: "cleanup-timeout",
      active: false,
      scores: { chat: 0, codex: 0 },
      autopsy: {
        status: "rolled-back",
        reason: "cleanup-timeout",
        patch: null,
        explanation: null,
        deltaMs: null,
        durations: { timeToGreenMs: null },
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === "overlay" && event.event.type === "tests.green",
      ),
    ).toBe(false);
    expect(activate.mock.calls.map(([, phase]) => phase)).toEqual([
      "broken",
      "repaired",
      "rollback",
    ]);
    breakGame(engine);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe("SDK presentation honesty", () => {
  it("maps observed read/test commands without leaking outputs or claiming shell success proves green", () => {
    expect(
      sdkOverlayEvent("r", sdk("/bin/zsh -lc 'cat src/step.ts'")),
    ).toMatchObject({
      type: "codex.step",
      step: { kind: "reading", path: "step.ts" },
      status: "running",
    });
    expect(sdkOverlayEvent("r", sdk("pnpm test"))).toMatchObject({
      step: { kind: "tests" },
      status: "running",
    });
    expect(
      sdkOverlayEvent("r", sdk("node node_modules/vitest/vitest.mjs run")),
    ).toMatchObject({ step: { kind: "tests" }, status: "running" });
    expect(
      sdkOverlayEvent("r", sdk("pnpm test", "failed", "secret", 1)),
    ).toMatchObject({ status: "failed" });
    expect(
      sdkOverlayEvent("r", sdk("pnpm test", "completed", "secret", 0)),
    ).toMatchObject({ step: { kind: "tests" }, status: "done" });
    expect(sdkOverlayEvent("r", sdk("echo vitest"))).toMatchObject({
      step: { kind: "activity", action: "command" },
    });
    expect(
      sdkOverlayEvent("r", {
        type: "item.completed",
        item: {
          id: "msg",
          type: "agent_message",
          text: "All tests green. gravity-sign",
        },
      }),
    ).toMatchObject({ step: { kind: "activity", action: "respond" } });
    expect(
      sdkOverlayEvent("r", {
        type: "item.completed",
        item: {
          id: "patch",
          type: "file_change",
          changes: [{ path: "src/step.ts", kind: "update" }],
          status: "completed",
        },
      }),
    ).toMatchObject({ step: { kind: "activity", action: "edit" } });
  });
});
