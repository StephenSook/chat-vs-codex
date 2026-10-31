import { xoroshiro128plus } from "pure-rand";
import {
  BRICK_H,
  BRICK_W,
  BRICKS,
  HEIGHT,
  PADDLE_HALF,
  PADDLE_Y,
  Q,
  RADIUS,
  WIDTH,
} from "./world.js";

export {
  BRICK_H,
  BRICK_W,
  BRICKS,
  HEIGHT,
  PADDLE_HALF,
  PADDLE_Y,
  Q,
  WIDTH,
} from "./world.js";
export const INPUT = { LEFT: 1, RIGHT: 2, LAUNCH: 4 } as const;
export interface State {
  frame: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  paddle: number;
  bricks: number;
  score: number;
  alive: boolean;
  won: boolean;
  launched: boolean;
}
export function createState(seed = 13): State {
  const [value] = xoroshiro128plus(seed).next();
  return {
    frame: 0,
    x: WIDTH / 2,
    y: PADDLE_Y - RADIUS - Q,
    vx: (value & 1 ? 3 : -3) * Q,
    vy: -4 * Q,
    paddle: WIDTH / 2,
    bricks: 0xffffff,
    score: 0,
    alive: true,
    won: false,
    launched: false,
  };
}
function advancePaddle(paddle: number, input: number): number {
  const direction =
    Number(Boolean(input & INPUT.RIGHT)) - Number(Boolean(input & INPUT.LEFT));
  return Math.max(
    PADDLE_HALF,
    Math.min(WIDTH - PADDLE_HALF, paddle + direction * 7 * Q),
  );
}
function wallBounce(next: State): void {
  if (next.x < RADIUS) {
    next.x = RADIUS;
    next.vx = Math.abs(next.vx);
  }
  if (next.x > WIDTH - RADIUS) {
    next.x = WIDTH - RADIUS;
    next.vx = -Math.abs(next.vx);
  }
  if (next.y < RADIUS) {
    next.y = RADIUS;
    next.vy = Math.abs(next.vy);
  }
}
function paddleBounce(next: State, previousY: number): void {
  if (
    next.vy > 0 &&
    previousY + RADIUS <= PADDLE_Y &&
    next.y + RADIUS >= PADDLE_Y &&
    next.x + RADIUS >= next.paddle - PADDLE_HALF &&
    next.x - RADIUS <= next.paddle + PADDLE_HALF
  ) {
    next.y = PADDLE_Y - RADIUS;
    next.vy = -Math.abs(next.vy);
    const offset = Math.trunc((next.x - next.paddle) / (14 * Q));
    next.vx = (offset === 0 ? (next.vx < 0 ? -2 : 2) : offset * 2) * Q;
  }
}
function hitBrick(next: State, previousY: number): void {
  for (const brick of BRICKS) {
    if (!(next.bricks & (1 << brick.id))) continue;
    if (
      next.x + RADIUS >= brick.x &&
      next.x - RADIUS <= brick.x + BRICK_W &&
      next.y + RADIUS >= brick.y &&
      next.y - RADIUS <= brick.y + BRICK_H
    ) {
      next.bricks &= ~(1 << brick.id);
      next.score += 10;
      if (
        previousY + RADIUS <= brick.y ||
        previousY - RADIUS >= brick.y + BRICK_H
      )
        next.vy = -next.vy;
      else next.vx = -next.vx;
      break;
    }
  }
}
export function step(state: State, input: number): State {
  if (!Number.isSafeInteger(input) || input < 0 || input > 7)
    throw new Error("Invalid input bitmask");
  const next = { ...state, frame: state.frame + 1 };
  if (!next.alive || next.won) return next;
  next.paddle = advancePaddle(next.paddle, input);
  if (!next.launched) {
    next.x = next.paddle;
    if (!(input & INPUT.LAUNCH)) return next;
    next.launched = true;
  }
  const previousY = next.y;
  next.x += next.vx;
  next.y += next.vy;
  wallBounce(next);
  paddleBounce(next, previousY);
  hitBrick(next, previousY);
  if (next.y - RADIUS > HEIGHT) next.alive = false;
  if (next.bricks === 0) next.won = true;
  return next;
}
export function hashState(state: State): string {
  let hash = 2166136261;
  for (const value of [
    state.frame,
    state.x,
    state.y,
    state.vx,
    state.vy,
    state.paddle,
    state.bricks,
    state.score,
    Number(state.alive),
    Number(state.won),
    Number(state.launched),
  ]) {
    for (let byte = 0; byte < 4; byte++) {
      hash ^= (value >>> (byte * 8)) & 255;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}
