import { createState, hashState, INPUT, step } from "@chat-vs-codex/sim";
import { describe, expect, it } from "vitest";
import { IdleAutopilot } from "../src/autopilot.js";
import { CLEAN_TRACK, FRAME_MS, SimulationPlayer } from "../src/simulation.js";

function engage(autopilot: IdleAutopilot, player: SimulationPlayer): void {
  for (let tick = 0; tick < 12; tick++) autopilot.advance(player, 250, 0);
  expect(autopilot.active).toBe(true);
}

function canonicalState(frame: number) {
  let state = createState(CLEAN_TRACK.seed);
  for (const input of CLEAN_TRACK.inputs.slice(0, frame))
    state = step(state, input);
  return state;
}

describe("idle canonical autopilot", () => {
  it("waits three seconds, then starts the installed game's route at spawn", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    player.state = { ...player.state, x: player.state.x + 4000, alive: false };
    for (let tick = 0; tick < 11; tick++) autopilot.advance(player, 250, 0);
    expect(autopilot.active).toBe(false);
    expect(player.state.alive).toBe(false);
    autopilot.advance(player, 250, 0);
    expect(autopilot.active).toBe(true);
    expect(player.state).toEqual(canonicalState(15));
  });

  it.each([30, 60, 120])(
    "consumes canonical per-frame inputs at %i display Hz",
    (hz) => {
      const player = new SimulationPlayer("play");
      const autopilot = new IdleAutopilot();
      engage(autopilot, player);
      for (let tick = 0; tick < hz; tick++)
        autopilot.advance(player, 1000 / hz, 0);
      expect(player.state).toEqual(canonicalState(75));
    },
  );

  it("never takes over a held key and starts its idle wait after release", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    for (let tick = 0; tick < 20; tick++)
      autopilot.advance(player, 250, INPUT.RIGHT);
    expect(autopilot.active).toBe(false);
    autopilot.takeOver();
    for (let tick = 0; tick < 11; tick++) autopilot.advance(player, 250, 0);
    expect(autopilot.active).toBe(false);
    autopilot.advance(player, 250, 0);
    expect(autopilot.active).toBe(true);
  });

  it("gives a game key immediate control without resetting the live state", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    engage(autopilot, player);
    const before = player.state;
    autopilot.takeOver();
    expect(autopilot.active).toBe(false);
    expect(player.state).toBe(before);
    autopilot.advance(player, FRAME_MS, INPUT.LEFT);
    expect(player.state).toEqual(step(before, INPUT.LEFT));
    for (let tick = 0; tick < 11; tick++) autopilot.advance(player, 250, 0);
    expect(autopilot.active).toBe(false);
  });

  it("holds a real patched-build death, then restarts the same installed build", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    const patchedStep: typeof step = (state, input) => ({
      ...step(state, input),
      alive: state.frame < 20,
    });
    player.install({ createState, hashState, step: patchedStep });
    engage(autopilot, player);
    expect(autopilot.advance(player, FRAME_MS * 6, 0).deaths).toBe(1);
    const dead = player.state;
    expect(dead.alive).toBe(false);
    for (let frame = 0; frame < 71; frame++)
      expect(autopilot.advance(player, FRAME_MS, 0).deaths).toBe(0);
    expect(player.state).toBe(dead);
    autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toEqual(createState(CLEAN_TRACK.seed));
    for (let frame = 0; frame < 21; frame++)
      autopilot.advance(player, FRAME_MS, 0);
    expect(player.state.alive).toBe(false);
    expect(autopilot.active).toBe(true);
  });

  it("reaches the canonical flag, holds it briefly, and repeats from the same seed", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    engage(autopilot, player);
    for (let frame = 0; frame < 600 && !player.state.won; frame++)
      autopilot.advance(player, FRAME_MS, 0);
    expect(player.state.won).toBe(true);
    const flag = player.state;
    for (let frame = 0; frame < 71; frame++)
      autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toBe(flag);
    autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toEqual(createState(CLEAN_TRACK.seed));
    autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toEqual(canonicalState(1));
  });

  it("does not relabel ordinary replay mode or fast-forward after suspension", () => {
    const replay = new SimulationPlayer("replay");
    const autopilot = new IdleAutopilot();
    for (let tick = 0; tick < 12; tick++) autopilot.advance(replay, 250, 0);
    expect(autopilot.active).toBe(false);
    expect(replay.state).toEqual(canonicalState(180));
    const player = new SimulationPlayer("play");
    autopilot.advance(player, 60000, 0);
    expect(autopilot.active).toBe(false);
    expect(player.state.frame).toBe(15);
  });

  it("bounds each route even when a patched build cannot die or reach the flag", () => {
    const player = new SimulationPlayer("play");
    const autopilot = new IdleAutopilot();
    player.install({
      createState,
      hashState,
      step: (state: ReturnType<typeof createState>, input: number) => ({
        ...step(state, input),
        alive: true,
        won: false,
      }),
    });
    engage(autopilot, player);
    for (let frame = 15; frame < CLEAN_TRACK.inputs.length; frame++)
      autopilot.advance(player, FRAME_MS, 0);
    const last = player.state;
    expect(last.frame).toBe(CLEAN_TRACK.inputs.length);
    for (let frame = 0; frame < 71; frame++)
      autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toBe(last);
    autopilot.advance(player, FRAME_MS, 0);
    expect(player.state).toEqual(createState(CLEAN_TRACK.seed));
  });
});
