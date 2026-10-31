export const Q = 256;
export const WIDTH = 480 * Q;
export const HEIGHT = 320 * Q;
export const RADIUS = 5 * Q;
export const PADDLE_Y = 292 * Q;
export const PADDLE_HALF = 42 * Q;
export const BRICK_W = 52 * Q;
export const BRICK_H = 14 * Q;
export const BRICKS = Array.from({ length: 24 }, (_, id) => ({
  id,
  x: (22 + (id % 8) * 55) * Q,
  y: (32 + Math.trunc(id / 8) * 20) * Q,
}));
