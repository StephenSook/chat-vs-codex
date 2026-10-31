import type { ValidatedReplayFrame } from "../../../packages/bench/src/validated-replay.js";
import type * as Simulation from "../../../packages/sim/src/index.js";
import type { JudgeEvidence, Receipt } from "./evidence.js";

export type GameModule = typeof Simulation;
export const sha256 = async (bytes: Uint8Array | string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof bytes === "string"
          ? new TextEncoder().encode(bytes)
          : new Uint8Array(bytes),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function proofAvailability(
  receipt: Receipt,
  buildDigest: string,
): string | null {
  if (!receipt.validationReplay)
    return "This legacy receipt has no recorded frame digest.";
  if (receipt.validationReplay.buildDigest !== buildDigest)
    return "The recorded patched build is not in this static evidence bundle.";
  const installed = receipt.verification.builds.at(-1);
  if (installed?.digest !== buildDigest || !installed.statePreserved)
    return "The receipt does not bind this build to a state-preserving installation.";
  return null;
}

/** Execute precisely the validator's post-step projection and JSON field order. */
export async function replayProof(
  game: GameModule,
  evidence: JudgeEvidence["replay"],
  receipt: Receipt,
): Promise<{
  frames: ValidatedReplayFrame[];
  framesDigest: string;
  trackDigest: string;
}> {
  const unavailable = proofAvailability(receipt, evidence.buildDigest);
  if (unavailable) throw new Error(unavailable);
  const recorded = receipt.validationReplay;
  if (!recorded) throw new Error("No recorded replay");
  const track = evidence.track;
  if (
    !track.inputs.length ||
    track.inputs.length > 3600 ||
    track.inputs.some((mask) => !Number.isInteger(mask) || mask < 0 || mask > 7)
  )
    throw new Error("Invalid validation frame budget");
  const trackDigest = await sha256(JSON.stringify(track));
  if (
    trackDigest !== recorded.trackDigest ||
    track.inputs.length !== recorded.frameCount
  )
    throw new Error("Validation track digest or frame budget mismatch");
  let state = game.createState(track.seed);
  const frames: ValidatedReplayFrame[] = [];
  for (const input of track.inputs) {
    state = game.step(state, input);
    frames.push({
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
      stateHash: game.hashState(state),
    });
  }
  const framesDigest = await sha256(JSON.stringify(frames));
  if (framesDigest !== recorded.framesDigest)
    throw new Error("Re-simulated frames do not match the receipt");
  return { frames, framesDigest, trackDigest };
}

/** Verify downloaded bytes before importing that exact byte sequence. */
export async function loadVerifiedGame(
  bytes: Uint8Array,
  expectedDigest: string,
  importer: (url: string) => Promise<GameModule> = (url) =>
    import(/* @vite-ignore */ url),
): Promise<GameModule> {
  if ((await sha256(bytes)) !== expectedDigest)
    throw new Error("Simulation artifact SHA-256 mismatch");
  const blob = new Blob([new Uint8Array(bytes)], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await importer(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
