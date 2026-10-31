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
  it("shows the real raid count through preparation and head start", () => {
    const raid = reduceBroadcast(initialBroadcast(), {
      type: "twitch.raid",
      viewers: 42,
    });
    expect(raid.raidViewers).toBe(42);
    const preparing = reduceBroadcast(raid, {
      type: "round.preparing",
      id: "r1",
    });
    expect(preparing.raidViewers).toBe(42);
    expect(
      reduceBroadcast(preparing, {
        type: "round.started",
        id: "r1",
        number: 1,
        atMs: 1,
      }).raidViewers,
    ).toBe(42);
  });
  it("orders SDK rows by original start rather than completion or patch observation", () => {
    let state = started();
    const event = (
      id: string,
      startedAtMs: number,
      status: "running" | "done",
    ) => ({
      type: "codex.step" as const,
      roundId: "r1",
      id,
      startedAtMs,
      step: { kind: "activity" as const, action: "edit" as const },
      status,
      attempt: 1,
      total: 1,
    });
    state = reduceBroadcast(state, event("edit", 10, "running"));
    state = reduceBroadcast(state, event("patch", 20, "done"));
    state = reduceBroadcast(state, event("edit", 30, "done"));
    state = reduceBroadcast(state, event("read", 5, "done"));
    expect(state.steps.map((row) => row.id)).toEqual(["read", "edit", "patch"]);
    expect(state.steps.find((row) => row.id === "edit")?.startedAtMs).toBe(10);
    for (let n = 0; n < 4; n++)
      state = reduceBroadcast(state, event(`later-${n}`, 40 + n, "done"));
    state = reduceBroadcast(state, event("edit", 99, "done"));
    expect(state.steps.map((row) => row.id)).toEqual([
      "later-0",
      "later-1",
      "later-2",
      "later-3",
    ]);
    expect(state.stepStarts["id:edit"]).toBe(10);
  });
  it("keeps SDK test-command success separate from the trusted full-suite green", () => {
    let state = reduceBroadcast(started(), {
      type: "codex.step",
      roundId: "r1",
      id: "tests",
      step: { kind: "tests" },
      status: "done",
      attempt: 1,
      total: 1,
    });
    expect(state.steps[0]?.label).toBe("Tests passed");
    expect(state.bug).not.toBe("fixed");
    state = reduceBroadcast(state, {
      type: "codex.step",
      roundId: "r1",
      id: "compound",
      step: { kind: "activity", action: "edit-test" },
      status: "done",
      attempt: 1,
      total: 1,
    });
    expect(state.steps.at(-1)?.label).toBe("Edit/test command passed");
    state = reduceBroadcast(state, { type: "tests.green", roundId: "r1" });
    expect(state.steps.at(-1)).toEqual({
      id: "validated-tests",
      label: "Tests green",
      status: "done",
    });
    expect(state.bug).toBe("fixed");
    expect(
      reduceBroadcast(state, { type: "tests.green", roundId: "r1" }).steps,
    ).toEqual(state.steps);
  });

  it("uses fixed safe labels for every observed activity category", () => {
    expect(stepLabel({ kind: "activity", action: "discover" })).toBe(
      "Inspecting files",
    );
    expect(stepLabel({ kind: "activity", action: "edit" })).toBe(
      "Editing source",
    );
    expect(stepLabel({ kind: "activity", action: "respond" })).toBe(
      "Preparing response",
    );
    expect(stepLabel({ kind: "activity", action: "tool" })).toBe("Using tool");
  });
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

  it("uses the configured observed head start instead of an implicit 15 seconds", () => {
    const state = reduceBroadcast(initialBroadcast(), {
      type: "round.started",
      id: "r",
      number: 1,
      atMs: 1000,
      headStartMs: 3000,
    });
    expect(headStartSeconds(state, 1000)).toBe(3);
    expect(headStartSeconds(state, 4000)).toBe(0);
    expect(
      headStartSeconds(
        reduceBroadcast(state, {
          type: "round.started",
          id: "r2",
          number: 2,
          atMs: 4000,
          headStartMs: 0,
        }),
        4000,
      ),
    ).toBe(0);
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
