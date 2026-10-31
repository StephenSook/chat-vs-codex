import type { ReplayResult } from "../../replay/src/index.js";

export type { ReplayResult } from "../../replay/src/index.js";
export interface ReplayEvidence {
  name: string;
  failed: boolean;
  firstDivergence: number | null;
  visibleFrame: number | null;
  symptom: string | null;
}

/** Fixed-point positions are compared in pixels, never to hash differences alone. */
export function compareReplay(
  name: string,
  clean: Pick<ReplayResult, "hashes" | "outcome" | "samples">,
  bugged: Pick<ReplayResult, "hashes" | "outcome" | "samples">,
): ReplayEvidence {
  if (clean.samples.length !== bugged.samples.length || !clean.samples.length) {
    throw new Error("Incomplete replay samples");
  }
  let firstDivergence: number | null = null;
  let visibleFrame: number | null = null;
  let symptom: string | null = null;
  for (let i = 0; i < clean.samples.length; i++) {
    const a = clean.samples[i];
    const b = bugged.samples[i];
    if (!a || !b || a.frame !== b.frame)
      throw new Error("Mismatched replay frames");
    if (firstDivergence === null && a.stateHash !== b.stateHash)
      firstDivergence = b.frame;
    if (b.frame > 600 || visibleFrame !== null) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (!b.alive && a.alive) {
      visibleFrame = b.frame;
      symptom = "The player dies before reaching the flag.";
    } else if (dx * dx + dy * dy > (32 * 256) ** 2) {
      visibleFrame = b.frame;
      symptom =
        Math.abs(dy) > Math.abs(dx)
          ? dy < 0
            ? "The player drifts upward while airborne."
            : "The player falls below the expected landing."
          : dx < 0
            ? "The player falls behind the expected route."
            : "The player overshoots the expected route.";
    }
  }
  return {
    name,
    failed:
      JSON.stringify(clean.hashes) !== JSON.stringify(bugged.hashes) ||
      JSON.stringify(clean.outcome) !== JSON.stringify(bugged.outcome),
    firstDivergence,
    visibleFrame,
    symptom,
  };
}
