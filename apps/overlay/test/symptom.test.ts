import { createState, hashState, step } from "@chat-vs-codex/sim";
import { expect, it } from "vitest";
import type { SymptomReplay } from "../../../packages/round/src/contracts.js";
import { OrderedRoundBridge, parseRoundEnvelope } from "../src/bridge.js";
import {
  createEventBus,
  initialBroadcast,
  reduceBroadcast,
} from "../src/events.js";
import { SimulationPlayer } from "../src/simulation.js";
import { SymptomReel, validSymptomReplay } from "../src/symptom.js";

function recording(): SymptomReplay {
  const state = createState();
  return {
    fps: 60,
    buildDigest: "a".repeat(64),
    sourceDigest: "b".repeat(64),
    trackDigest: "c".repeat(64),
    firstDivergentFrame: 1,
    focus: "enemy",
    frames: [0, 1, 2].map((frame) => ({
      frame,
      x: state.x + frame * 256,
      y: state.y,
      vx: 256,
      vy: 0,
      alive: true,
      won: false,
      enemy: { ...state.enemy, x: state.enemy.x + frame * 256 },
    })),
  };
}
it.each([false, true])(
  "only publishes symptom samples matching the installed build (tamper=%s)",
  async (tamper) => {
    const simulation = new SimulationPlayer("play");
    const events = createEventBus();
    const observed: string[] = [];
    const errors: string[] = [];
    let broadcast = initialBroadcast();
    events.subscribe((event) => {
      observed.push(event.type);
      broadcast = reduceBroadcast(broadcast, event);
    });
    const bridge = new OrderedRoundBridge({
      simulation,
      events,
      loadBuild: async () => ({ createState, step, hashState }),
      onError: (error) => errors.push(error.message),
    });
    await bridge.receive({
      sequence: 1,
      serverTimeMs: 0,
      event: {
        type: "round.state",
        roundId: "r",
        phase: "preparing",
        headStartEndsAt: null,
        winner: null,
        reason: null,
      },
    });
    await bridge.receive({
      sequence: 2,
      serverTimeMs: 0,
      event: {
        type: "game.build",
        roundId: "r",
        phase: "broken",
        buildId: "a".repeat(64),
        digest: "a".repeat(64),
      },
    });
    await bridge.receive({
      sequence: 3,
      serverTimeMs: 0,
      event: {
        type: "overlay",
        event: { type: "round.started", id: "r", number: 1, atMs: 0 },
      },
    });
    const replay = recording();
    if (tamper) replay.buildDigest = "d".repeat(64);
    const publication = bridge.receive({
      sequence: 4,
      serverTimeMs: 0,
      event: {
        type: "overlay",
        event: { type: "round.symptom", roundId: "r", replay },
      },
    });
    if (tamper)
      await expect(publication).rejects.toThrow(
        "Symptom recording does not match",
      );
    else await publication;
    expect(observed.includes("round.symptom")).toBe(!tamper);
    expect(errors).toHaveLength(tamper ? 1 : 0);
    expect(broadcast.roundId).toBe("r");
    bridge.close();
  },
);
it("loops only during head start, renders recorded enemy positions, and leaves the live state untouched", () => {
  const live = createState();
  const before = structuredClone(live);
  const reel = new SymptomReel();
  reel.observe({ type: "round.started", id: "r", number: 1, atMs: 100 });
  const replay = recording();
  reel.observe({ type: "round.symptom", roundId: "old", replay });
  expect(reel.view(100, true, live)).toBeNull();
  reel.observe({ type: "round.symptom", roundId: "r", replay });
  expect(reel.view(117, true, live)).toMatchObject({
    frame: 1,
    focus: "enemy",
    state: { enemy: replay.frames[1]?.enemy },
  });
  expect(reel.view(151, true, live)?.frame).toBe(0);
  expect(reel.view(151, false, live)).toBeNull();
  expect(reel.view(151, true, live, true)?.frame).toBe(2);
  expect(live).toEqual(before);
  const first = replay.frames[0];
  if (first) first.x = 999;
  expect(reel.view(100, true, live)?.state.x).toBe(live.x);
  reel.observe({ type: "round.preparing", id: "next" });
  expect(reel.view(100, true, live)).toBeNull();
});
it("validates bounded wire recordings before rendering and rejects invented frame order", () => {
  expect(validSymptomReplay(recording())).toBe(true);
  for (const bad of [
    null,
    { ...recording(), buildDigest: "invalid" },
    { ...recording(), focus: "gravity-sign" },
    { ...recording(), frames: [] },
    { ...recording(), frames: [...recording().frames].reverse() },
  ]) {
    expect(validSymptomReplay(bad)).toBe(false);
    expect(() =>
      parseRoundEnvelope({
        sequence: 1,
        serverTimeMs: 0,
        event: {
          type: "overlay",
          event: { type: "round.symptom", roundId: "r", replay: bad },
        },
      }),
    ).toThrow();
  }
});
