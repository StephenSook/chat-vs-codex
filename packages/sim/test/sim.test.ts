import { describe, expect, it } from "vitest";
import {
  COYOTE_FRAMES,
  createState,
  HEIGHT,
  hashState,
  INPUT,
  LEVEL,
  type State,
  step,
  UNIT,
  WIDTH,
} from "../src/index.js";

function advance(initial: State, frames: number, input = 0): State {
  let state = initial;
  for (let frame = 0; frame < frames; frame++) state = step(state, input);
  return state;
}
describe("fixed timestep simulation", () => {
  it("keeps the tile map rectangular", () => {
    expect(LEVEL).toHaveLength(HEIGHT);
    expect(LEVEL.every((row) => row.length === WIDTH)).toBe(true);
  });
  it("keeps caller state and RNG immutable", () => {
    const state = createState(42);
    const before = structuredClone(state);
    Object.freeze(state.rng);
    Object.freeze(state);
    step(state, INPUT.RIGHT | INPUT.JUMP);
    expect(state).toEqual(before);
    expect(hashState(createState(42))).toBe(hashState(state));
    expect(hashState(createState(43))).not.toBe(hashState(state));
  });
  it("runs in both directions and cancels opposing controls", () => {
    const state = createState();
    expect(step(state, INPUT.RIGHT).x).toBe(state.x + 3 * UNIT);
    expect(step(state, INPUT.LEFT).x).toBe(state.x - 3 * UNIT);
    expect(step(state, INPUT.LEFT | INPUT.RIGHT).x).toBe(state.x);
  });
  it("resolves a wall horizontally and the floor vertically", () => {
    const wall = advance(createState(), 70, INPUT.RIGHT);
    expect(wall.x).toBe(204 * UNIT);
    expect(wall.y).toBe(296 * UNIT);
    expect(wall.grounded).toBe(true);
    const falling = advance(
      { ...createState(), y: 240 * UNIT, grounded: false },
      30,
    );
    expect(falling.y).toBe(296 * UNIT);
    expect(falling.vy).toBe(0);
  });
  it("allows coyote jumps only inside the grace window", () => {
    const inAir = {
      ...createState(),
      y: 200 * UNIT,
      grounded: false,
      coyote: COYOTE_FRAMES,
    };
    expect(step(inAir, INPUT.JUMP).jumps).toBe(1);
    expect(step({ ...inAir, coyote: 0 }, INPUT.JUMP).jumps).toBe(0);
  });
  it("buffers a new press before landing and does not auto-jump a held key", () => {
    const falling = {
      ...createState(),
      y: 294 * UNIT,
      vy: 3 * UNIT,
      grounded: false,
      coyote: 0,
    };
    const landed = step(falling, INPUT.JUMP);
    const jumped = step(landed, 0);
    expect(jumped.bufferedJumps).toBe(1);
    expect(jumped.vy).toBeLessThan(0);
    const held = advance(step(createState(), INPUT.JUMP), 100, INPUT.JUMP);
    expect(held.jumps).toBe(1);
  });
  it("kills on a hazard, reaches the flag, and freezes terminal positions", () => {
    const dead = step({ ...createState(), x: 320 * UNIT, y: 298 * UNIT }, 0);
    expect(dead.alive).toBe(false);
    expect(step(dead, INPUT.RIGHT).x).toBe(dead.x);
    const won = step({ ...createState(), x: 1152 * UNIT }, 0);
    expect(won.won).toBe(true);
    expect(step(won, INPUT.LEFT).x).toBe(won.x);
  });
  it("reproduces integer state and hashes for the same seed and inputs", () => {
    const a = advance(createState(7), 180, INPUT.RIGHT);
    const b = advance(createState(7), 180, INPUT.RIGHT);
    expect(a).toEqual(b);
    expect(hashState(a)).toBe(hashState(b));
    expect([a.x, a.y, a.vx, a.vy].every(Number.isInteger)).toBe(true);
  });
});
