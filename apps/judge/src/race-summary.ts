import type { Receipt } from "./evidence.js";

export const RACE_RULE =
  "!break -> !guess <bug> -> first correct guess races Codex.";

type RaceReceipt = Pick<Receipt, "winner" | "firstCorrectGuesser"> & {
  durations?: Pick<NonNullable<Receipt["durations"]>, "headStartMs"> | null;
};

/** Repair completion and race victory are independent recorded outcomes. */
export function raceSummary(receipt: RaceReceipt): {
  winner: string;
  firstCorrect: string;
  headStart: string;
} {
  const headStartMs = receipt.durations?.headStartMs;
  return {
    winner: receipt.winner?.toUpperCase() ?? "none",
    firstCorrect: receipt.firstCorrectGuesser ?? "none",
    headStart:
      headStartMs != null && Number.isFinite(headStartMs) && headStartMs >= 0
        ? `${Number((headStartMs / 1000).toFixed(2))} s`
        : "unavailable",
  };
}
