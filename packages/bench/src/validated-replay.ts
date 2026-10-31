import { createHash } from "node:crypto";
import { goldenResult, HELD_OUT } from "../../replay/src/index.js";

export interface ValidatedReplayFrame {
  frame: number;
  x: number;
  y: number;
  alive: boolean;
  won: boolean;
  stateHash: string;
}
export interface ValidatedReplay {
  fps: 60;
  trackDigest: string;
  frames: ValidatedReplayFrame[];
}
export const REPLAY_TRACE_PREFIX = "CV_VALIDATED_REPLAY ";

/** Accept only the bounded output of the held-out validator after its gate passed. */
export function validatedReplay(stdout: string): ValidatedReplay {
  const records = stdout
    .split("\n")
    .filter((line) => line.startsWith(REPLAY_TRACE_PREFIX));
  if (records.length !== 1)
    throw new Error("Missing or ambiguous validated replay trace");
  const record = records[0];
  if (!record) throw new Error("Missing validated replay");
  const parsed: unknown = JSON.parse(record.slice(REPLAY_TRACE_PREFIX.length));
  if (!Array.isArray(parsed) || parsed.length !== HELD_OUT.inputs.length)
    throw new Error("Invalid held-out frame budget");
  const frames: ValidatedReplayFrame[] = parsed.map(
    (value: unknown, index: number) => {
      if (!value || typeof value !== "object")
        throw new Error("Invalid held-out frame");
      const row = value as Record<string, unknown>;
      if (
        row.frame !== index + 1 ||
        !Number.isSafeInteger(row.x) ||
        !Number.isSafeInteger(row.y) ||
        typeof row.alive !== "boolean" ||
        typeof row.won !== "boolean" ||
        typeof row.stateHash !== "string" ||
        !/^[a-f0-9]{8}$/.test(row.stateHash)
      )
        throw new Error("Invalid held-out frame");
      return {
        frame: row.frame as number,
        x: row.x as number,
        y: row.y as number,
        alive: row.alive,
        won: row.won,
        stateHash: row.stateHash,
      };
    },
  );
  const hashes = frames
    .filter((frame) => frame.frame % 60 === 0)
    .map(({ frame, stateHash }) => ({ frame, hash: stateHash }));
  const last = frames.at(-1);
  if (!last) throw new Error("Empty held-out trace");
  const outcome = {
    frame: last.frame,
    x: last.x,
    y: last.y,
    alive: last.alive,
    won: last.won,
  };
  if (
    JSON.stringify({ hashes, outcome }) !==
    JSON.stringify(goldenResult(HELD_OUT))
  )
    throw new Error("Held-out trace differs from validated golden");
  return {
    fps: 60,
    trackDigest: createHash("sha256")
      .update(JSON.stringify(HELD_OUT))
      .digest("hex"),
    frames,
  };
}
