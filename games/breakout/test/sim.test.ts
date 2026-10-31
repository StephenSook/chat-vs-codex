import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canary, HELD_OUT, runTrack, TRACKS } from "../replay.js";
import {
  createState,
  hashState,
  INPUT,
  PADDLE_HALF,
  PADDLE_Y,
  Q,
  step,
} from "../src/index.js";

it("is seeded, integer deterministic and frame-bounded", () => {
  for (const track of [...TRACKS, HELD_OUT])
    expect(runTrack(track)).toEqual(runTrack(track));
  expect(hashState(createState(13))).toEqual(hashState(createState(13)));
  const track = TRACKS[0];
  if (!track) throw new Error("Missing replay");
  expect(() =>
    runTrack({ ...track, inputs: Array<number>(3601).fill(0) }),
  ).toThrow("budget");
  expect(canary()).toEqual({ frames: 1200, alive: true, won: false });
});
it("moves the paddle, launches, bounces and dies below the floor", () => {
  const initial = createState(13);
  expect(step(initial, INPUT.LEFT).paddle).toBe(initial.paddle - 7 * Q);
  expect(initial.frame).toBe(0);
  expect(step({ ...initial, paddle: PADDLE_HALF }, INPUT.LEFT).paddle).toBe(
    PADDLE_HALF,
  );
  expect(step(initial, 0).launched).toBe(false);
  expect(step(initial, INPUT.LAUNCH).launched).toBe(true);
  const bounce = step(
    {
      ...initial,
      launched: true,
      x: initial.paddle,
      y: PADDLE_Y - 6 * Q,
      vy: 4 * Q,
    },
    0,
  );
  expect(bounce.vy).toBeLessThan(0);
  expect(step({ ...initial, launched: true, y: 330 * Q }, 0).alive).toBe(false);
  expect(() => step(initial, 8)).toThrow("bitmask");
});
it("matches committed replay goldens, including the held-out route", () => {
  const goldens = JSON.parse(
    readFileSync(new URL("../goldens.json", import.meta.url), "utf8"),
  );
  for (const track of [...TRACKS, HELD_OUT]) {
    const { hashes, outcome } = runTrack(track);
    expect({ hashes, outcome }).toEqual(goldens[track.name]);
  }
});
it("keeps original game source free from mutation comments and floating trig", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/@hotfix-site|Math\.(sin|cos|pow|random)/);
});

it("bounces at arena walls, removes a brick, scores and wins when the last brick breaks", () => {
  const state = { ...createState(13), launched: true };
  const wall = step(
    { ...state, x: 5 * Q, y: 10 * Q, vx: -3 * Q, vy: -4 * Q },
    0,
  );
  expect(wall.vx).toBeGreaterThan(0);
  const ceiling = step({ ...state, x: 240 * Q, y: 5 * Q, vy: -4 * Q }, 0);
  expect(ceiling.vy).toBeGreaterThan(0);
  const cleared = step(
    { ...state, bricks: 1, x: 30 * Q, y: 52 * Q, vx: 0, vy: -4 * Q },
    0,
  );
  expect(cleared.score).toBe(10);
  expect(cleared.bricks).toBe(0);
  expect(cleared.won).toBe(true);
  expect(cleared.vy).toBeGreaterThan(0);
  const terminal = step(cleared, INPUT.RIGHT);
  expect(terminal.x).toBe(cleared.x);
  expect(terminal.frame).toBe(cleared.frame + 1);
});
