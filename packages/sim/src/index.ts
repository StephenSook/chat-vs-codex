import { xoroshiro128plus } from "pure-rand";
import {
  BUFFER_FRAMES,
  COYOTE_FRAMES,
  GRAVITY,
  HEIGHT,
  INPUT,
  JUMP_SPEED,
  LEVEL,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  platformAt,
  type Rect,
  SPAWN,
  SPEED,
  type State,
  TILE,
  UNIT,
  WIDTH,
} from "./world.js";

export * from "./world.js";

export function createState(seed = 1): State {
  return {
    frame: 0,
    ...SPAWN,
    vx: 0,
    vy: 0,
    grounded: true,
    platform: false,
    coyote: COYOTE_FRAMES,
    buffer: 0,
    jumpHeld: false,
    alive: true,
    won: false,
    jumps: 0,
    bufferedJumps: 0,
    platformLandings: 0,
    edgeLandings: 0,
    rng: xoroshiro128plus(seed).getState(),
  };
}

// @hotfix-site collision
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
function tileRects(x: number, y: number): Rect[] {
  const tiles: Rect[] = [];
  const minX = Math.max(0, Math.floor(x / TILE));
  const maxX = Math.min(WIDTH - 1, Math.floor((x + PLAYER_WIDTH - 1) / TILE));
  const minY = Math.max(0, Math.floor(y / TILE));
  const maxY = Math.min(HEIGHT - 1, Math.floor((y + PLAYER_HEIGHT - 1) / TILE));
  for (let row = minY; row <= maxY; row++) {
    for (let column = minX; column <= maxX; column++) {
      if (LEVEL[row]?.[column] === "#") {
        tiles.push({
          x: column * TILE,
          y: row * TILE,
          width: TILE,
          height: TILE,
        });
      }
    }
  }
  return tiles;
}
function resolveX(x: number, y: number, vx: number): number {
  let result = x + vx;
  for (const tile of tileRects(result, y)) {
    if (
      overlaps(
        { x: result, y, width: PLAYER_WIDTH, height: PLAYER_HEIGHT },
        tile,
      )
    ) {
      result = vx > 0 ? tile.x - PLAYER_WIDTH : tile.x + tile.width;
    }
  }
  return result;
}
function resolveY(
  x: number,
  y: number,
  vy: number,
): { y: number; grounded: boolean } {
  let result = y + vy;
  let grounded = false;
  for (const tile of tileRects(x, result)) {
    if (
      overlaps(
        { x, y: result, width: PLAYER_WIDTH, height: PLAYER_HEIGHT },
        tile,
      )
    ) {
      if (vy > 0) {
        result = tile.y - PLAYER_HEIGHT;
        grounded = true;
      } else if (vy < 0) result = tile.y + tile.height;
    }
  }
  return { y: result, grounded };
}
// @hotfix-site-end collision

// @hotfix-site input
function horizontalVelocity(input: number): number {
  const left = (input & INPUT.LEFT) !== 0 ? 1 : 0;
  const right = (input & INPUT.RIGHT) !== 0 ? 1 : 0;
  const direction = left - right;
  return 0 - direction * SPEED;
}
// @hotfix-site-end input

// @hotfix-site physics
function verticalVelocity(vy: number): number {
  return Math.min(vy + GRAVITY, 12 * UNIT);
}
// @hotfix-site-end physics

/** Pure fixed-timestep transition. No clock, mutable module state or DOM. */
export function step(state: State, input: number): State {
  if (!state.alive || state.won) return { ...state, frame: state.frame + 1 };
  const pressed = (input & INPUT.JUMP) !== 0;
  let buffer =
    pressed && !state.jumpHeld ? BUFFER_FRAMES : Math.max(0, state.buffer - 1);
  let coyote = state.grounded ? COYOTE_FRAMES : Math.max(0, state.coyote - 1);
  let vy = verticalVelocity(state.vy);
  let jumps = state.jumps;
  let bufferedJumps = state.bufferedJumps;
  if (buffer > 0 && coyote > 0) {
    vy = -JUMP_SPEED;
    jumps++;
    if (!(pressed && !state.jumpHeld)) bufferedJumps++;
    buffer = 0;
    coyote = 0;
  }
  const vx = horizontalVelocity(input);
  const oldPlatform = platformAt(state.frame);
  const nextPlatform = platformAt(state.frame + 1);
  const carriedX = state.platform
    ? state.x + nextPlatform.x - oldPlatform.x
    : state.x;
  const x = resolveX(carriedX, state.y, vx);
  const vertical = resolveY(x, state.y, vy);
  let y = vertical.y;
  let grounded = vertical.grounded;
  let platform = false;
  let platformLandings = state.platformLandings;
  let edgeLandings = state.edgeLandings;
  if (
    vy >= 0 &&
    state.y + PLAYER_HEIGHT <= nextPlatform.y &&
    y + PLAYER_HEIGHT >= nextPlatform.y &&
    x + PLAYER_WIDTH > nextPlatform.x &&
    x < nextPlatform.x + nextPlatform.width
  ) {
    y = nextPlatform.y - PLAYER_HEIGHT;
    grounded = true;
    platform = true;
    if (!state.platform) {
      platformLandings++;
      if (
        x < nextPlatform.x ||
        x + PLAYER_WIDTH > nextPlatform.x + nextPlatform.width
      )
        edgeLandings++;
    }
  }
  if (grounded || y !== state.y + vy) vy = 0;
  let alive = y < HEIGHT * TILE;
  let won = false;
  const player = { x, y, width: PLAYER_WIDTH, height: PLAYER_HEIGHT };
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const tile = LEVEL[row]?.[column];
      if (
        (tile === "!" || tile === "G") &&
        overlaps(player, {
          x: column * TILE,
          y: row * TILE,
          width: TILE,
          height: TILE,
        })
      ) {
        if (tile === "!") alive = false;
        else won = true;
      }
    }
  }
  return {
    ...state,
    frame: state.frame + 1,
    x,
    y,
    vx,
    vy,
    grounded,
    platform,
    coyote,
    buffer,
    jumpHeld: pressed,
    alive,
    won: alive && won,
    jumps,
    bufferedJumps,
    platformLandings,
    edgeLandings,
  };
}

/** FNV-1a over an explicit canonical byte representation of every state field. */
export function hashState(state: State): string {
  const values = [
    state.frame,
    state.x,
    state.y,
    state.vx,
    state.vy,
    Number(state.grounded),
    Number(state.platform),
    state.coyote,
    state.buffer,
    Number(state.jumpHeld),
    Number(state.alive),
    Number(state.won),
    state.jumps,
    state.bufferedJumps,
    state.platformLandings,
    state.edgeLandings,
    ...state.rng,
  ];
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let byte = 0; byte < 4; byte++) {
      hash ^= (value >>> (byte * 8)) & 255;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}
