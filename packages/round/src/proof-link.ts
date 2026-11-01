import type { RoundAutopsy } from "./contracts.js";

export const JUDGE_URL = "https://chat-vs-codex-judge.vercel.app/";
export const ROUND_PROOF_HASH = "#r=";

/** Encode the ID so result text cannot alter the destination or fragment. */
export function roundProofUrl(roundId: string): string {
  return `${JUDGE_URL}${ROUND_PROOF_HASH}${encodeURIComponent(roundId)}`;
}

export type FixedRoundMessage = Pick<RoundAutopsy, "roundId" | "family"> & {
  timeToGreenMs: number;
  regression: boolean;
};

export function fixedRoundMessage(card: FixedRoundMessage): string {
  const total = Math.round(card.timeToGreenMs / 10);
  const split = `${Math.floor(total / 6000)}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
  return `Codex fixed ${card.family}. GREEN ${split}${card.regression ? " | +1 test" : ""} ${roundProofUrl(card.roundId)}`;
}

export function failedRoundMessage(
  card: Pick<RoundAutopsy, "roundId" | "reason">,
): string {
  const outcome =
    card.reason === "rollback-failed" || card.reason === "rollback-timeout"
      ? "Restore needs attention."
      : "The game was rolled back.";
  return `Codex failed. ${outcome} ${roundProofUrl(card.roundId)}`;
}
