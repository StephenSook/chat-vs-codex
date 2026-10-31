import type { TriagePrediction } from "./predict.js";
/** Includes the offline pool's catch-all label; this is not the public !guess enum. */
export const TRIAGE_FAMILIES = [
  "platformer:other",
  "platformer:gravity-sign",
  "platformer:collision-off-by-one",
  "platformer:swapped-controls",
  "platformer:coyote-never-expires",
  "platformer:jump-buffer",
  "platformer:enemy-ledge-turn",
  "breakout:createState",
  "breakout:paddleBounce",
  "breakout:wallBounce",
  "breakout:hitBrick",
] as const;
export function validPrediction(value: unknown): value is TriagePrediction {
  if (!value || typeof value !== "object") return false;
  const p = value as TriagePrediction;
  return (
    TRIAGE_FAMILIES.includes(p.family as (typeof TRIAGE_FAMILIES)[number]) &&
    Number.isFinite(p.confidence) &&
    p.confidence >= 0 &&
    p.confidence <= 1 &&
    /^[a-f0-9]{64}$/.test(p.modelDigest)
  );
}
/** Enum-only model evidence. Never accepts a viewer's free text. */
export function triageHint(prediction: TriagePrediction): string {
  if (!validPrediction(prediction)) throw new Error("Invalid triage hint");
  return `\nTelemetry classifier guess (may be wrong): ${prediction.family.split(":")[1]}; uncalibrated score ${Math.round(prediction.confidence * 100)}%. Treat as a hypothesis and verify with the immutable replay suite.`;
}
