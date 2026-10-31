import type { State } from "@chat-vs-codex/sim";
import type { SymptomReplay } from "../../../packages/round/src/contracts.js";
import type { OverlayEvent } from "./events.js";

export function validSymptomReplay(value: unknown): value is SymptomReplay {
  if (!value || typeof value !== "object") return false;
  const r = value as SymptomReplay;
  return (
    r.fps === 60 &&
    [r.buildDigest, r.sourceDigest, r.trackDigest].every(
      (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
    ) &&
    ["player", "enemy"].includes(r.focus) &&
    Number.isSafeInteger(r.firstDivergentFrame) &&
    r.firstDivergentFrame >= 0 &&
    Array.isArray(r.frames) &&
    r.frames.length >= 2 &&
    r.frames.length <= 601 &&
    r.frames.every(
      (f, index) =>
        f &&
        typeof f === "object" &&
        [f.frame, f.x, f.y, f.vx, f.vy].every(Number.isSafeInteger) &&
        f.frame >= 0 &&
        f.frame <= 600 &&
        (index === 0 || f.frame === (r.frames[index - 1]?.frame ?? -2) + 1) &&
        typeof f.alive === "boolean" &&
        typeof f.won === "boolean" &&
        f.enemy &&
        [
          f.enemy.x,
          f.enemy.y,
          f.enemy.vy,
          f.enemy.direction,
          f.enemy.turns,
        ].every(Number.isSafeInteger),
    )
  );
}

/** Recorded pixels only. The live world's state and clock are never replaced. */
export class SymptomReel {
  private roundId: string | null = null;
  private replay: SymptomReplay | null = null;
  private startedAtMs = 0;
  observe(event: OverlayEvent): void {
    if (event.type === "round.preparing" || event.type === "round.started") {
      if (event.id !== this.roundId || event.type === "round.preparing")
        this.replay = null;
      this.roundId = event.id;
      if (event.type === "round.started") this.startedAtMs = event.atMs;
    }
    if (event.type === "round.symptom" && event.roundId === this.roundId) {
      if (!validSymptomReplay(event.replay))
        throw new Error("Invalid symptom recording");
      this.replay = structuredClone(event.replay);
    }
  }
  view(nowMs: number, headStart: boolean, live: State, reducedMotion = false) {
    if (!headStart || !this.replay || !Number.isFinite(nowMs)) return null;
    const replay = this.replay;
    const index = reducedMotion
      ? Math.min(
          replay.frames.length - 1,
          replay.firstDivergentFrame - (replay.frames[0]?.frame ?? 0) + 30,
        )
      : Math.floor((Math.max(0, nowMs - this.startedAtMs) * 60) / 1000) %
        replay.frames.length;
    const sample = replay.frames[index];
    if (!sample) return null;
    return {
      state: { ...live, ...sample } as State,
      focus: replay.focus,
      frame: sample.frame,
      buildDigest: replay.buildDigest,
    };
  }
}
