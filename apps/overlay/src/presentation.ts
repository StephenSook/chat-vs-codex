import {
  HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type State,
  TILE,
  UNIT,
  WIDTH,
} from "@chat-vs-codex/sim";
import type { BroadcastState } from "./events.js";

export const VIEWPORT = { width: 1200, height: 560 } as const;
export type CameraMode = "follow" | "overview";
const WORLD_WIDTH = (WIDTH * TILE) / UNIT;
const WORLD_HEIGHT = (HEIGHT * TILE) / UNIT;
// Twice the original full-level renderer's 1728 / 1280 scale.
export const FOLLOW_ZOOM = (2 * 1728) / WORLD_WIDTH;

export function actorPositions(state: State) {
  return {
    player: { x: state.x / UNIT, y: state.y / UNIT },
    enemy: { x: state.enemy.x / UNIT, y: state.enemy.y / UNIT },
  };
}

export function cameraFor(x: number, y: number, mode: CameraMode) {
  const zoom =
    mode === "overview"
      ? Math.min(VIEWPORT.width / WORLD_WIDTH, VIEWPORT.height / WORLD_HEIGHT)
      : FOLLOW_ZOOM;
  const clamp = (value: number, max: number) =>
    Math.max(0, Math.min(max, value));
  const offset = (center: number, viewport: number, world: number) =>
    world * zoom <= viewport
      ? (viewport - world * zoom) / 2
      : -clamp(center * zoom - viewport / 2, world * zoom - viewport);
  const left = offset(
    (x + PLAYER_WIDTH / 2) / UNIT,
    VIEWPORT.width,
    WORLD_WIDTH,
  );
  const top = offset(
    (y + PLAYER_HEIGHT / 2) / UNIT,
    VIEWPORT.height,
    WORLD_HEIGHT,
  );
  return {
    zoom,
    left,
    top,
    player: {
      x: (x / UNIT) * zoom + left,
      y: (y / UNIT) * zoom + top,
      width: (PLAYER_WIDTH / UNIT) * zoom,
      height: (PLAYER_HEIGHT / UNIT) * zoom,
    },
  };
}

/** A clock changes pixels only. Only an observed active bug permits corruption. */
export function corruptionFor(
  state: BroadcastState,
  nowMs: number,
  reducedMotion: boolean,
) {
  const intensity = state.bug === "active" ? state.intensity : 0;
  return {
    intensity,
    rgbOffset: reducedMotion ? 0 : intensity * 9,
    band: reducedMotion ? 0 : Math.floor(nowMs / 140) % 8,
    treatment: intensity === 0 ? "none" : reducedMotion ? "static" : "animated",
  } as const;
}
