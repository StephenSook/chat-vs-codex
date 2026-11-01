import type { BatchSummary } from "../../../packages/bench/src/statistics.js";
import type { JudgeEvidence } from "./evidence.js";

/** Prefer the real viewer race. Test fallback stays explicitly labelled. */
export function featuredRound(rounds: JudgeEvidence["rounds"]): string | null {
  const viewers = rounds.filter(
    ({ receipt }) =>
      receipt.mode === "live-twitch" &&
      receipt.trigger !== "broadcaster-test" &&
      receipt.autopsy?.trigger !== "broadcaster-test" &&
      !receipt.events.some((event) => event.trigger === "broadcaster-test") &&
      !receipt.autopsy?.boss,
  );
  return (
    (
      viewers.find(({ receipt }) => receipt.winner === "chat") ??
      viewers[0] ??
      rounds.find(({ receipt }) => receipt.roundId.startsWith("c37736fc"))
    )?.receipt.roundId ?? null
  );
}

/** The race compares the planned runtime model against the measured bench rule. */
export function benchmarkRaceLine(summary: BatchSummary): string {
  const median = summary.models.find(
    (model) => model.model === "gpt-6.1-terra" && model.effort === "low",
  )?.overall.medianGreenMs;
  return `Terra median ${median == null ? "unavailable" : `${(median / 1000).toFixed(1)} s`} · chat's head start ${Number((summary.headStartMs / 1000).toFixed(1))} s`;
}
