import { createState, hashState, step } from "@chat-vs-codex/sim";
import { describe, expect, it } from "vitest";
import type {
  RoundAutopsy,
  RoundValidationReplay,
} from "../../../packages/round/src/contracts.js";
import { initialBroadcast, reduceBroadcast } from "../src/events.js";
import {
  MAX_GHOST_FRAMES,
  RecordedGhost,
  validGhostReplay,
} from "../src/ghost.js";
import { FRAME_MS, SimulationPlayer } from "../src/simulation.js";

/** Short actual-sim samples for wire/playback unit tests, not validation evidence. */
function replayFixture(count = 60): RoundValidationReplay {
  let state = createState(1);
  return {
    fps: 60,
    sourceDigest: "a".repeat(64),
    trackDigest: "b".repeat(64),
    frames: Array.from({ length: count }, () => {
      state = step(state, 2);
      return {
        frame: state.frame,
        x: state.x,
        y: state.y,
        alive: state.alive,
        won: state.won,
        stateHash: hashState(state),
      };
    }),
  };
}

function observedGhost(replay = replayFixture()) {
  const ghost = new RecordedGhost();
  ghost.observe({ type: "round.started", id: "r", number: 1, atMs: 0 });
  ghost.observe({ type: "round.ghost", roundId: "r", replay });
  return ghost;
}

describe("recorded held-out ghost", () => {
  it("requires actual observed samples, uses a separate 60 Hz clock and never changes the live sim", () => {
    const ghost = new RecordedGhost();
    const live = new SimulationPlayer("play");
    const state = live.state;
    const hash = live.hash();
    expect(ghost.advance(999999)).toBeNull();
    const replay = replayFixture();
    ghost.observe({ type: "round.started", id: "r", number: 1, atMs: 0 });
    ghost.observe({ type: "round.ghost", roundId: "r", replay });
    expect(ghost.advance(0)?.index).toBe(0);
    expect(ghost.advance(FRAME_MS)?.index).toBe(1);
    expect(ghost.advance(FRAME_MS)?.replay.frames[2]).toEqual(replay.frames[2]);
    expect(live.state).toBe(state);
    expect(live.hash()).toBe(hash);
    // Caller changes cannot rewrite the recorded samples during playback.
    const first = replay.frames[0];
    if (!first) throw new Error("Missing unit fixture sample");
    first.x = 999;
    expect(ghost.advance(0)?.replay.frames[0]?.x).not.toBe(999);
  });

  it("finishes at the last recorded sample without looping, and respects reduced motion", () => {
    const ghost = observedGhost(replayFixture(3));
    expect(ghost.advance(250)).toMatchObject({ index: 2, complete: true });
    expect(ghost.advance(999999)).toMatchObject({ index: 2, complete: true });
    const reduced = observedGhost();
    expect(reduced.advance(0, true)).toMatchObject({
      index: 59,
      complete: true,
      reducedMotion: true,
    });
    expect(reduced.snapshot()).toMatchObject({ frame: 60, complete: true });
    const suspended = observedGhost();
    expect(suspended.advance(999999)?.index).toBe(15);
    expect(suspended.advance(Number.NaN)?.index).toBe(15);
  });

  it("ignores stale rounds, retains playback through green, and clears on new preparation or rollback", () => {
    const ghost = observedGhost();
    ghost.observe({
      type: "round.ghost",
      roundId: "old",
      replay: replayFixture(2),
    });
    ghost.observe({ type: "tests.green", roundId: "r" });
    expect(ghost.snapshot()?.frames).toBe(60);
    ghost.observe({ type: "round.preparing", id: "next" });
    expect(ghost.snapshot()).toBeNull();
    ghost.observe({
      type: "round.ghost",
      roundId: "r",
      replay: replayFixture(),
    });
    expect(ghost.advance(0)).toBeNull();
    ghost.observe({
      type: "round.ghost",
      roundId: "next",
      replay: replayFixture(),
    });
    ghost.clear(); // Successful rollback-install callback, without a synthetic round event.
    expect(ghost.snapshot()).toBeNull();
  });

  it("bounds wire samples, requires sequential frames and refuses malformed digests and hashes", () => {
    const replay = replayFixture(2);
    expect(validGhostReplay(replay)).toBe(true);
    for (const invalid of [
      { ...replay, fps: 30 },
      { ...replay, sourceDigest: "no" },
      { ...replay, trackDigest: "no" },
      { ...replay, frames: [] },
      {
        ...replay,
        frames: new Array(MAX_GHOST_FRAMES + 1).fill(replay.frames[0]),
      },
      { ...replay, frames: [{ ...replay.frames[0], frame: 2 }] },
      { ...replay, frames: [{ ...replay.frames[0], x: Number.NaN }] },
      { ...replay, frames: [{ ...replay.frames[0], stateHash: "wrong" }] },
    ])
      expect(validGhostReplay(invalid)).toBe(false);
  });

  it("clears both playback and retained evidence on an observed rolled-back autopsy", () => {
    const autopsy: RoundAutopsy = {
      roundId: "r",
      status: "rolled-back",
      reason: "validation-failed",
      breaker: null,
      firstCorrectGuesser: null,
      family: null,
      winner: null,
      patch: null,
      explanation: null,
      durations: {
        headStartMs: null,
        repairMs: null,
        validationMs: null,
        swapMs: null,
        timeToGreenMs: null,
      },
      previousRoundId: null,
      deltaMs: null,
      regressionTest: null,
      regressionError: null,
    };
    const ghost = observedGhost();
    const event = { type: "round.autopsy", roundId: "r", autopsy } as const;
    ghost.observe(event);
    expect(ghost.advance(0)).toBeNull();
    let state = reduceBroadcast(initialBroadcast(), {
      type: "round.started",
      id: "r",
      number: 1,
      atMs: 0,
    });
    state = reduceBroadcast(state, {
      type: "round.ghost",
      roundId: "r",
      replay: replayFixture(),
    });
    expect(reduceBroadcast(state, event).ghost).toBeNull();
  });

  it("retains typed replay evidence in broadcast state without inventing activity, scores or green", () => {
    const start = reduceBroadcast(initialBroadcast(), {
      type: "round.started",
      id: "r",
      number: 1,
      atMs: 0,
    });
    const replay = replayFixture();
    const state = reduceBroadcast(start, {
      type: "round.ghost",
      roundId: "r",
      replay,
    });
    expect(state.ghost).toBe(replay);
    expect(state.steps).toEqual([]);
    expect(state.chat + state.codex).toBe(0);
    expect(state.bug).toBe("none");
    expect(
      reduceBroadcast(state, { type: "tests.green", roundId: "r" }).ghost,
    ).toBe(replay);
    expect(
      reduceBroadcast(state, { type: "round.preparing", id: "next" }).ghost,
    ).toBeNull();
    expect(
      reduceBroadcast(state, { type: "round.ghost", roundId: "old", replay }),
    ).toBe(state);
  });
});
