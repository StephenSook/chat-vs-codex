import {
  HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  type State,
  TILE,
  UNIT,
  WIDTH,
} from "@chat-vs-codex/sim";
import type { RoundAutopsy } from "../../../packages/round/src/contracts.js";
import type { BroadcastState } from "./events.js";
import type { GhostView } from "./ghost.js";

export const VIEWPORT = { width: 1200, height: 560 } as const;
export type CameraMode = "follow" | "overview";
const WORLD_WIDTH = (WIDTH * TILE) / UNIT;
const WORLD_HEIGHT = (HEIGHT * TILE) / UNIT;
// Twice the original full-level renderer's 1728 / 1280 scale.
export const FOLLOW_ZOOM = (2 * 1728) / WORLD_WIDTH;

const seconds = (milliseconds: number | null) =>
  milliseconds === null
    ? "Not measured"
    : `${(milliseconds / 1000).toFixed(2)}s`;
export function splitTime(milliseconds: number): string {
  const hundredths = Math.round(milliseconds / 10);
  return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}
/** Exact source substrings around the first changed column. Ellipses mark omitted context. */
export function diffExcerpts(preview: readonly string[]) {
  const removed = preview.find((line) => line.startsWith("-"));
  const added = preview.find((line) => line.startsWith("+"));
  const selected = removed && added ? [removed, added] : preview.slice(0, 2);
  let changedColumn = 0;
  if (removed && added) {
    const before = removed.slice(1);
    const after = added.slice(1);
    while (
      changedColumn < Math.min(before.length, after.length) &&
      before[changedColumn] === after[changedColumn]
    )
      changedColumn++;
  }
  return selected.map((source) => {
    let text = source;
    if (source.length > 19) {
      const body = source.slice(1);
      const left = Math.max(0, Math.min(changedColumn, body.length - 1) - 7);
      const budget = 18 - (left > 0 ? 1 : 0);
      let right = Math.min(body.length, left + budget);
      if (right < body.length) right--;
      text = `${source[0]}${left > 0 ? "…" : ""}${body.slice(left, right)}${right < body.length ? "…" : ""}`;
    }
    return { source, text };
  });
}

export function autopsyView(record: RoundAutopsy) {
  const restoreFailed =
    record.reason === "rollback-failed" || record.reason === "rollback-timeout";
  const diffLines = record.patch?.preview.length
    ? diffExcerpts(record.patch.preview)
    : [{ text: "Diff unavailable", source: "Diff unavailable" }];
  return {
    diffLines,
    verdict:
      record.status === "rolled-back"
        ? restoreFailed
          ? "RESTORE FAILED"
          : "ROUND ROLLED BACK"
        : record.winner === "chat"
          ? "CHAT FOUND IT"
          : record.winner === "codex"
            ? "CODEX FIXED IT"
            : "FIX VERIFIED",
    family: record.family ?? "Family unavailable",
    breaker: `BREAK: ${record.breaker ?? "Not recorded"}`,
    guesser: `FOUND: ${record.firstCorrectGuesser ?? "No correct guess"}`,
    diff: diffLines.map((line) => line.text).join("\n"),
    patch: record.patch
      ? `Patch +${record.patch.added} / -${record.patch.removed}`
      : "Patch counts unavailable",
    explanation: record.headline?.trim() || "Headline unavailable",
    green:
      record.status === "rolled-back"
        ? "NO VERIFIED GREEN"
        : record.durations.timeToGreenMs === null
          ? "Green time not measured"
          : `GREEN ${splitTime(record.durations.timeToGreenMs)}`,
    splits: [
      `HEAD START ${seconds(record.durations.headStartMs)}`,
      `REPAIR ${seconds(record.durations.repairMs)}`,
      `TESTS ${seconds(record.durations.validationMs)}`,
      `SWAP ${seconds(record.durations.swapMs)}`,
    ],
    delta:
      record.deltaMs === null
        ? "Previous split unavailable"
        : `${record.deltaMs >= 0 ? "+" : "-"}${splitTime(Math.abs(record.deltaMs))} vs previous`,
    trend:
      record.deltaMs === null
        ? "missing"
        : record.deltaMs < 0
          ? "faster"
          : record.deltaMs > 0
            ? "slower"
            : "equal",
    reason: record.reason,
    regression: record.regressionTest
      ? "+1 test"
      : record.regressionError
        ? "Test not saved"
        : null,
    regressionStatus: record.regressionTest
      ? "saved"
      : record.regressionError
        ? "failed"
        : null,
    regressionDetail: record.regressionTest
      ? `${record.breaker ? `Found by ${record.breaker}\n` : ""}${record.regressionTest.path}\nSHA-256 ${record.regressionTest.digest}`
      : record.regressionError,
  };
}

/** Both actors share this world camera; during validation the recorded actor leads it. */
export function playfieldCamera(
  state: State,
  mode: CameraMode,
  ghost: GhostView | null,
  validating: boolean,
) {
  const sample = validating ? ghost?.replay.frames[ghost.index] : undefined;
  return cameraFor(sample?.x ?? state.x, sample?.y ?? state.y, mode);
}

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
