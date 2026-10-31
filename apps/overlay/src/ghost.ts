import type { RoundValidationReplay } from "../../../packages/round/src/contracts.js";
import type { OverlayEvent } from "./events.js";

export const MAX_GHOST_FRAMES = 3600;
const SHA256 = /^[a-f0-9]{64}$/;

/** Validate the wire shape only. The server binds these samples to its held-out gate. */
export function validGhostReplay(
  value: unknown,
): value is RoundValidationReplay {
  if (!value || typeof value !== "object") return false;
  const replay = value as RoundValidationReplay;
  return (
    replay.fps === 60 &&
    typeof replay.sourceDigest === "string" &&
    SHA256.test(replay.sourceDigest) &&
    typeof replay.trackDigest === "string" &&
    SHA256.test(replay.trackDigest) &&
    Array.isArray(replay.frames) &&
    replay.frames.length > 0 &&
    replay.frames.length <= MAX_GHOST_FRAMES &&
    replay.frames.every(
      (frame, index) =>
        !!frame &&
        typeof frame === "object" &&
        frame.frame === index + 1 &&
        Number.isSafeInteger(frame.x) &&
        Number.isSafeInteger(frame.y) &&
        typeof frame.alive === "boolean" &&
        typeof frame.won === "boolean" &&
        typeof frame.stateHash === "string" &&
        /^[a-f0-9]{8}$/.test(frame.stateHash),
    )
  );
}

export interface GhostView {
  replay: RoundValidationReplay;
  index: number;
  complete: boolean;
  reducedMotion: boolean;
}

/** A recorded route has its own clock and never steps or writes the live simulation. */
export class RecordedGhost {
  private roundId: string | null = null;
  private replay: RoundValidationReplay | null = null;
  private elapsedMs = 0;
  private displayedIndex = 0;

  observe(event: OverlayEvent): void {
    if (event.type === "round.preparing" || event.type === "round.started") {
      if (event.id !== this.roundId || event.type === "round.preparing") {
        this.roundId = event.id;
        this.clear();
      }
    } else if (
      event.type === "round.autopsy" &&
      event.autopsy.status === "rolled-back"
    ) {
      if (event.roundId === this.roundId) this.clear();
    } else if (event.type === "round.ghost" && event.roundId === this.roundId) {
      if (!validGhostReplay(event.replay))
        throw new Error("Invalid validated replay");
      this.replay = structuredClone(event.replay);
      this.elapsedMs = 0;
      this.displayedIndex = 0;
    }
  }

  clear(): void {
    this.replay = null;
    this.elapsedMs = 0;
    this.displayedIndex = 0;
  }

  advance(elapsedMs: number, reducedMotion = false): GhostView | null {
    if (!this.replay) return null;
    // A paused browser does not skip the entire route on its first frame back.
    if (Number.isFinite(elapsedMs))
      this.elapsedMs += Math.max(0, Math.min(elapsedMs, 250));
    const last = this.replay.frames.length - 1;
    const index = reducedMotion
      ? last
      : Math.min(last, Math.floor((this.elapsedMs * 60) / 1000));
    this.displayedIndex = index;
    return {
      replay: this.replay,
      index,
      complete: index === last,
      reducedMotion,
    };
  }

  snapshot() {
    if (!this.replay) return null;
    const index = this.displayedIndex;
    return {
      sourceDigest: this.replay.sourceDigest,
      trackDigest: this.replay.trackDigest,
      frames: this.replay.frames.length,
      frame: this.replay.frames[index]?.frame,
      stateHash: this.replay.frames[index]?.stateHash,
      complete: index === this.replay.frames.length - 1,
    };
  }
}
