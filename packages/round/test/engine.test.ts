import type { ThreadEvent } from "@openai/codex-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GameArtifact,
  PreparedGame,
  RoundEvent,
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
    runtime: { prepare },
    activate,
    publish: (event) => events.push(event),
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
  it("publishes the configured head-start duration and starts repair at that deadline", async () => {
    const { engine, game, events, repair } = setup({ headStartMs: 2000 });
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({
      type: "overlay",
      event: expect.objectContaining({
        type: "round.started",
        headStartMs: 2000,
      }),
    });
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
    const { engine, game, repair, prepare } = setup();
    game.close = vi.fn(async () => new Promise<void>(() => {}));
    breakGame(engine);
    await vi.advanceTimersByTimeAsync(15_000);
    repair.resolve(repaired);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await engine.waitForRound()).toMatchObject({
      phase: "resolved",
      reason: "cleanup-timeout",
      active: false,
    });
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
      step: { kind: "reading", path: "source" },
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
    ).toBeNull();
    expect(sdkOverlayEvent("r", sdk("echo vitest"))).toBeNull();
    expect(
      sdkOverlayEvent("r", {
        type: "item.completed",
        item: {
          id: "msg",
          type: "agent_message",
          text: "All tests green. gravity-sign",
        },
      }),
    ).toBeNull();
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
    ).toBeNull();
  });
});
