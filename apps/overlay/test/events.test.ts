import { describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  headStartSeconds,
  initialBroadcast,
  reduceBroadcast,
  stepLabel,
} from "../src/events.js";

const started = () =>
  reduceBroadcast(initialBroadcast(), {
    type: "round.started",
    id: "r1",
    number: 1,
    atMs: 1000,
  });

describe("broadcast event contract", () => {
  it("does not invent activity or a head start before a round starts", () => {
    const state = initialBroadcast();
    expect(state.steps).toEqual([]);
    expect(state.bug).toBe("none");
    expect(state.chat + state.codex + state.deaths).toBe(0);
    expect(headStartSeconds(state, 9000)).toBeNull();
  });

  it("counts 15 real seconds from the supplied monotonic start time", () => {
    expect(headStartSeconds(started(), 1000)).toBe(15);
    expect(headStartSeconds(started(), 2001)).toBe(14);
    expect(headStartSeconds(started(), 15999)).toBe(1);
    expect(headStartSeconds(started(), 16000)).toBe(0);
    expect(headStartSeconds(started(), 999999)).toBe(0);
    expect(headStartSeconds(started(), 0)).toBe(15);
  });

  it("preserves observed scores but resets round activity and deaths", () => {
    let state = reduceBroadcast(started(), {
      type: "score.changed",
      chat: 2,
      codex: 1,
    });
    state = reduceBroadcast(state, { type: "simulation.death" });
    expect(state.deaths).toBe(1);
    state = reduceBroadcast(state, {
      type: "round.started",
      id: "r2",
      number: 2,
      atMs: 17000,
    });
    expect(state).toMatchObject({
      roundId: "r2",
      chat: 2,
      codex: 1,
      deaths: 0,
      steps: [],
      bug: "none",
    });
  });

  it("ignores late messages from a previous round", () => {
    const state = started();
    expect(
      reduceBroadcast(state, { type: "tests.green", roundId: "old" }),
    ).toBe(state);
    expect(
      reduceBroadcast(state, {
        type: "bug.active",
        roundId: "old",
        intensity: 1,
      }),
    ).toBe(state);
  });

  it("clamps live corruption and clears it on an observed green", () => {
    let state = reduceBroadcast(started(), {
      type: "bug.active",
      roundId: "r1",
      intensity: 5,
    });
    expect(state).toMatchObject({ bug: "active", intensity: 1 });
    state = reduceBroadcast(state, {
      type: "bug.named",
      roundId: "r1",
      name: "Gravity",
    });
    expect(state.bugName).toBe("Gravity");
    state = reduceBroadcast(state, { type: "tests.green", roundId: "r1" });
    expect(state).toMatchObject({ bug: "fixed", intensity: 0 });
    expect(
      reduceBroadcast(started(), {
        type: "bug.active",
        roundId: "r1",
        intensity: Number.NaN,
      }).intensity,
    ).toBe(0);
  });

  it("updates rows by id, keeps four, and never manufactures a green from a running test", () => {
    let state = started();
    for (let n = 0; n < 7; n++) {
      state = reduceBroadcast(state, {
        type: "codex.step",
        roundId: "r1",
        id: String(n),
        step: { kind: "tests" },
        status: "running",
        attempt: 1,
        total: 3,
      });
    }
    expect(state.steps).toHaveLength(4);
    expect(state.steps.every((row) => row.label === "Running tests")).toBe(
      true,
    );
    state = reduceBroadcast(state, {
      type: "codex.step",
      roundId: "r1",
      id: "6",
      step: { kind: "tests" },
      status: "failed",
      attempt: 1,
      total: 3,
    });
    expect(state.steps).toHaveLength(4);
    expect(state.steps.at(-1)?.status).toBe("failed");
    expect(state.attempt).toBe(1);
    expect(state.total).toBe(3);
    expect(state.bug).not.toBe("fixed");
  });

  it("clears old attempt rows and ignores late SDK retry completions", () => {
    const state = reduceBroadcast(started(), {
      type: "codex.step",
      roundId: "r1",
      id: "new",
      step: { kind: "replay" },
      status: "running",
      attempt: 2,
      total: 3,
    });
    expect(
      reduceBroadcast(state, {
        type: "codex.step",
        roundId: "r1",
        id: "old",
        step: { kind: "tests" },
        status: "done",
        attempt: 1,
        total: 3,
      }),
    ).toBe(state);
  });

  it("uses source filenames and real patch counts in the ticker", () => {
    expect(
      stepLabel({ kind: "reading", path: "packages/sim/src/world.ts" }),
    ).toBe("Reading world.ts");
    expect(stepLabel({ kind: "reading", path: "C:\\repo\\world.ts" })).toBe(
      "Reading world.ts",
    );
    expect(stepLabel({ kind: "patch", added: 2, removed: 1 })).toBe(
      "Patch +2 / -1",
    );
  });

  it("publishes synchronously and releases subscriptions", () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    const event = { type: "simulation.death" } as const;
    bus.publish(event);
    expect(listener).toHaveBeenCalledExactlyOnceWith(event);
    unsubscribe();
    bus.publish(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
