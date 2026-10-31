import { runTrack } from "@chat-vs-codex/replay";
import {
  createState,
  hashState,
  INPUT,
  LEVEL,
  PLAYER_HEIGHT,
  step,
  TILE,
  UNIT,
} from "@chat-vs-codex/sim";
import { describe, expect, it } from "vitest";
import { CLEAN_TRACK, FRAME_MS, SimulationPlayer } from "../src/simulation.js";

describe("overlay consumes the public simulation", () => {
  it("hot swaps actual physics without resetting state, frame, input clock carry or RNG", () => {
    const player = new SimulationPlayer("play");
    player.advance(FRAME_MS * 1.5, INPUT.RIGHT);
    const before = player.state;
    player.install({
      createState,
      hashState,
      step: (state: typeof before, input: number) => ({
        ...step(state, input),
        x: state.x + 5 * UNIT,
      }),
    });
    expect(player.state).toBe(before);
    player.advance(FRAME_MS * 0.5, INPUT.RIGHT);
    expect(player.state.frame).toBe(before.frame + 1);
    expect(player.state.x).toBe(before.x + 5 * UNIT);
    expect(player.state.rng).toEqual(before.rng);
    player.install({ createState, hashState, step });
    const repaired = player.state;
    player.advance(FRAME_MS, INPUT.RIGHT);
    expect(player.state).toEqual(step(repaired, INPUT.RIGHT));
  });

  it("rolls back incompatible module installs without mutating live state", () => {
    const player = new SimulationPlayer("play");
    const before = player.state;
    expect(() =>
      player.install({
        createState,
        hashState,
        step: (state: typeof before) => {
          (state as { x: number }).x = 0;
          return state;
        },
      }),
    ).toThrow();
    expect(player.state).toBe(before);
    expect(() =>
      player.install({ createState, hashState, step: () => ({}) }),
    ).toThrow("Invalid simulation state");
    player.advance(FRAME_MS, INPUT.RIGHT);
    expect(player.state).toEqual(step(before, INPUT.RIGHT));
  });
  it.each([30, 60, 120])(
    "replays the committed inputs identically at %i display Hz",
    (hz) => {
      const player = new SimulationPlayer("replay");
      for (let index = 0; index < hz * 10; index++) player.advance(1000 / hz);
      const expected = runTrack(CLEAN_TRACK);
      expect(player.state).toEqual(expected.final);
      expect(hashState(player.state)).toBe(expected.samples.at(-1)?.stateHash);
      expect(player.state.won).toBe(true);
    },
  );

  it("passes live input masks to the same sim without changing physics", () => {
    const player = new SimulationPlayer("play");
    player.advance(FRAME_MS, INPUT.RIGHT | INPUT.JUMP);
    expect(player.state).toEqual(
      step(createState(CLEAN_TRACK.seed), INPUT.RIGHT | INPUT.JUMP),
    );
  });

  it("counts a death once and freezes terminal position until restart", () => {
    const player = new SimulationPlayer("play");
    // Start at a real hazard; the counter must not depend on a particular jump arc.
    const row = LEVEL.findIndex((tiles) => tiles.includes("!"));
    const column = LEVEL[row]?.indexOf("!") ?? -1;
    expect(row).toBeGreaterThanOrEqual(0);
    expect(column).toBeGreaterThanOrEqual(0);
    player.state = {
      ...player.state,
      x: column * TILE,
      y: row * TILE - PLAYER_HEIGHT + UNIT,
      grounded: false,
    };
    const deaths = player.advance(FRAME_MS).deaths;
    expect(player.state.alive).toBe(false);
    expect(deaths).toBe(1);
    const x = player.state.x;
    expect(player.advance(200, INPUT.LEFT).deaths).toBe(0);
    expect(player.state.x).toBe(x);
    player.reset();
    expect(player.state).toEqual(createState(CLEAN_TRACK.seed));
  });

  it("bounds catch-up after tab suspension and ignores negative deltas", () => {
    const player = new SimulationPlayer("play");
    player.advance(60000, INPUT.RIGHT);
    expect(player.state.frame).toBe(15);
    player.advance(-100, INPUT.RIGHT);
    expect(player.state.frame).toBe(15);
  });

  it("holds the full clean track before looping, using the same seed", () => {
    const player = new SimulationPlayer("replay");
    for (let frame = 0; frame < CLEAN_TRACK.inputs.length + 30; frame++)
      player.advance(FRAME_MS);
    expect(player.state.frame).toBe(CLEAN_TRACK.inputs.length);
    for (let frame = 0; frame < 95; frame++) player.advance(FRAME_MS);
    expect(player.state.frame).toBeLessThan(10);
    expect(player.state.rng).toEqual(createState(CLEAN_TRACK.seed).rng);
  });
});
