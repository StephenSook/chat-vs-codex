import { expect, it } from "vitest";
import { OrderedRoundBridge } from "../src/bridge.js";
import {
  createEventBus,
  initialBroadcast,
  reduceBroadcast,
} from "../src/events.js";
import { SimulationPlayer } from "../src/simulation.js";

it("never displays a model family before the measured head-start boundary", () => {
  const initial = reduceBroadcast(initialBroadcast(), {
    type: "round.started",
    id: "round",
    number: 1,
    atMs: 100,
    headStartMs: 15000,
  });
  const prediction = {
    family: "platformer:jump-buffer",
    confidence: 0.7,
    modelDigest: "a".repeat(64),
  };
  const early = reduceBroadcast(initial, {
    type: "round.triage",
    roundId: "round",
    prediction,
    revealedAtMs: 15099,
  });
  expect(early.triage).toBeNull();
  const after = reduceBroadcast(initial, {
    type: "round.triage",
    roundId: "round",
    prediction,
    revealedAtMs: 15100,
  });
  expect(after.triage).toEqual(prediction);
  expect(
    reduceBroadcast(after, { type: "round.preparing", id: "next" }).triage,
  ).toBeNull();
  expect(
    reduceBroadcast(initial, {
      type: "round.triage",
      roundId: "other",
      prediction,
      revealedAtMs: 15100,
    }).triage,
  ).toBeNull();
});

it("maps host reveal timestamps into the same browser clock as round start before the spoil guard", async () => {
  let now = 10;
  const bus = createEventBus();
  let state = initialBroadcast();
  bus.subscribe((event) => {
    state = reduceBroadcast(state, event);
  });
  const bridge = new OrderedRoundBridge({
    simulation: new SimulationPlayer("play"),
    events: bus,
    loadBuild: async () => {
      throw new Error("No build needed for clock fixture");
    },
    now: () => now,
  });
  const prediction = {
    family: "platformer:other",
    confidence: 0.7,
    modelDigest: "a".repeat(64),
  };
  const envelope = (
    sequence: number,
    event: Parameters<typeof bus.publish>[0],
    hostTime: number,
  ) => ({
    sequence,
    serverTimeMs: hostTime,
    atMs: hostTime,
    deliveryAtMs: hostTime,
    event: { type: "overlay", event },
  });
  try {
    await bridge.receive(
      envelope(
        1,
        {
          type: "round.started",
          id: "r",
          number: 1,
          atMs: 1000000,
          headStartMs: 15000,
        },
        1000000,
      ),
    );
    expect(state.startedAtMs).toBe(10);
    now = 11;
    await bridge.receive(
      envelope(
        2,
        {
          type: "round.triage",
          roundId: "r",
          prediction,
          revealedAtMs: 1000001,
        },
        1000001,
      ),
    );
    expect(state.triage).toBeNull();
    now = 15010;
    await bridge.receive(
      envelope(
        3,
        {
          type: "round.triage",
          roundId: "r",
          prediction,
          revealedAtMs: 1015000,
        },
        1015000,
      ),
    );
    expect(state.triage).toEqual(prediction);
  } finally {
    bridge.close();
  }
});
