/** All distances use Q8 fixed point; one call to step is 1/60 second. */
export const UNIT = 256;
export const TILE = 32 * UNIT;
export const WIDTH = 40;
export const HEIGHT = 12;
export const PLAYER_WIDTH = 20 * UNIT;
export const PLAYER_HEIGHT = 24 * UNIT;
export const SPEED = 3 * UNIT;
export const GRAVITY = 128;
export const RISE_GRAVITY = 96;
export const FALL_GRAVITY = 192;
export const AIR_SPEED = 4 * UNIT;
export const AIR_ACCEL = UNIT;
export const PLATFORM_SPEED = 2 * UNIT;
export const JUMP_SPEED = 10 * UNIT;
export const COYOTE_FRAMES = 6;
export const BUFFER_FRAMES = 6;

export const INPUT = { LEFT: 1, RIGHT: 2, JUMP: 4 } as const;
export type Tile = "." | "#" | "!" | "G";
// Shared immutable level data is deliberately outside all hotfix regions.
export const LEVEL: readonly string[] = Object.freeze([
  "########################################",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................................#",
  "#......................####............#",
  "#......#............................G..#",
  "##########!!############################",
  "########################################",
]);
export const SPAWN = Object.freeze({ x: 64 * UNIT, y: 296 * UNIT });
export const PLATFORM = Object.freeze({
  x: 480 * UNIT,
  y: 256 * UNIT,
  width: 64 * UNIT,
  height: 12 * UNIT,
  travel: 48 * UNIT,
  period: 192,
});

export const ENEMY = Object.freeze({
  x: 800 * UNIT,
  y: 232 * UNIT,
  speed: UNIT,
});
export interface EnemyState {
  readonly x: number;
  readonly y: number;
  readonly vy: number;
  readonly direction: number;
  readonly turns: number;
}

export interface State {
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly grounded: boolean;
  readonly platform: boolean;
  readonly coyote: number;
  readonly buffer: number;
  readonly jumpHeld: boolean;
  readonly alive: boolean;
  readonly won: boolean;
  readonly jumps: number;
  readonly bufferedJumps: number;
  readonly platformLandings: number;
  readonly edgeLandings: number;
  readonly rng: readonly number[];
  readonly enemy: EnemyState;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function platformAt(frame: number): Rect {
  const phase = frame % PLATFORM.period;
  const triangle =
    phase < PLATFORM.period / 2 ? phase : PLATFORM.period - phase;
  return {
    x:
      PLATFORM.x +
      Math.trunc((triangle * PLATFORM.travel) / (PLATFORM.period / 2)),
    y: PLATFORM.y,
    width: PLATFORM.width,
    height: PLATFORM.height,
  };
}
