import type { Track } from "../../../packages/replay/src/index.js";
import type { publicReceipt } from "../../../packages/round/src/receipt.js";
import type { SecondGameEvidence } from "./second-game.js";

/** Type-only seam with the receipt producer. Legacy receipts lack newer fields. */
export type Receipt = Omit<ReturnType<typeof publicReceipt>, "clock"> & {
  clock: string;
};

export interface CanaryReceipt {
  path: string;
  digest: string;
  completedAt: string;
  kernelStatus: 0;
  sdkTurnCompleted: true;
  sdkOutputMatchesKernel: true;
  cleanValidation: "passed";
  controls: Record<string, boolean | string>;
}

export interface JudgeEvidence {
  schemaVersion: 1;
  commit: string;
  commitCount: number;
  sessionId: string;
  benchmark: { path: string; digest: string; batchId: string };
  regressionCount: number;
  regressionCommits: string[];
  rounds: {
    path: string;
    digest: string;
    receipt: Receipt;
    regression: { path: string; digest: string; retroactive: boolean } | null;
  }[];
  replay: { artifactPath: string; buildDigest: string; track: Track };
  canary: CanaryReceipt;
  secondGame?: SecondGameEvidence | null;
}

export function roundLabel(receipt: Receipt): string {
  if (
    receipt.trigger === "broadcaster-test" ||
    receipt.autopsy?.trigger === "broadcaster-test" ||
    receipt.events.some((event) => event.trigger === "broadcaster-test")
  )
    return "TWITCH CHAT ROUND / TEST";
  return receipt.mode === "live-twitch"
    ? "TWITCH CHAT ROUND / VIEWER"
    : "LOCAL ROUND / FIXTURE";
}

export function roundInputLabel(receipt: Receipt): string {
  return receipt.input ? `INPUT: ${receipt.input}` : "INPUT: Not recorded";
}

export function seconds(value: number | null | undefined): string {
  return value == null ? "unavailable" : `${(value / 1000).toFixed(2)} s`;
}

export function greenSplit(value: number | null | undefined): string {
  if (value == null) return "GREEN unavailable";
  const centiseconds = Math.round(value / 10);
  return `GREEN ${Math.floor(centiseconds / 6000)}:${((centiseconds % 6000) / 100).toFixed(2).padStart(5, "0")}`;
}

/** Early runs predate the measured autopsy. Keep their evidence, not a blank card. */
export function isEarlierTestRound(receipt: Receipt): boolean {
  return (
    receipt.durations?.timeToGreenMs == null &&
    !receipt.autopsy?.patch?.preview.length
  );
}
