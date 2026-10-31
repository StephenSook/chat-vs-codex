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
    Object.freeze(state.enemy);
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
  it("does not translate an idle player sideways during vertical depenetration", () => {
    const state = {
      ...createState(),
      x: 79 * UNIT,
      y: 298 * UNIT,
      grounded: false,
    };
    const next = step(state, 0);
    expect(next.x).toBe(state.x);
    expect(next.y).toBe(296 * UNIT);
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
  it("uses ground settling, slower rising gravity and faster falling gravity", () => {
    const state = { ...createState(), y: 180 * UNIT };
    expect(step(state, 0).vy).toBe(128);
    expect(step({ ...state, grounded: false, vy: -UNIT }, 0).vy).toBe(-160);
    expect(step({ ...state, grounded: false, vy: UNIT }, 0).vy).toBe(448);
  });
  it("accelerates air control and uses relative footing on moving platforms", () => {
    const state = {
      ...createState(),
      x: 520 * UNIT,
      y: 180 * UNIT,
      grounded: false,
    };
    expect(step(state, INPUT.RIGHT).vx).toBe(UNIT);
    expect(step({ ...state, vx: 3 * UNIT }, INPUT.RIGHT).vx).toBe(4 * UNIT);
    expect(step({ ...state, vx: -3 * UNIT }, INPUT.LEFT).vx).toBe(-4 * UNIT);
    expect(
      step({ ...state, grounded: true, platform: true }, INPUT.RIGHT).vx,
    ).toBe(2 * UNIT);
    expect(
      step({ ...state, grounded: true, platform: true }, INPUT.LEFT).vx,
    ).toBe(-2 * UNIT);
  });
  it("expires coyote time and pending presses while airborne", () => {
    const state = {
      ...createState(),
      y: 120 * UNIT,
      grounded: false,
      coyote: 1,
      buffer: 1,
    };
    const next = step(state, 0);
    expect(next.coyote).toBe(0);
    expect(next.buffer).toBe(0);
    expect(next.jumps).toBe(0);
  });
  it("turns the patrol before a ledge and keeps its immutable state in the hash", () => {
    let state = createState();
    for (let frame = 0; frame < 1200; frame++) {
      state = step(state, 0);
      expect(state.enemy.y).toBe(232 * UNIT);
      expect(state.enemy.x).toBeGreaterThanOrEqual(736 * UNIT);
      expect(state.enemy.x).toBeLessThanOrEqual(844 * UNIT);
    }
    expect(state.enemy.turns).toBeGreaterThan(0);
    expect(
      hashState({
        ...state,
        enemy: { ...state.enemy, direction: -state.enemy.direction },
      }),
    ).not.toBe(hashState(state));
  });
  it("kills the player on contact with an enemy", () => {
    const state = createState();
    const hit = step(
      { ...state, x: state.enemy.x, y: state.enemy.y, grounded: false },
      0,
    );
    expect(hit.alive).toBe(false);
  });
});
