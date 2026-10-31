import type { publicReceipt } from "./receipt.js";

export const SEASON_INPUTS = [
  "chat",
  "channel-points",
  "whisper",
  "raid",
  "power-up",
  "unknown",
] as const;
export type SeasonInput = (typeof SEASON_INPUTS)[number];
export interface SeasonTotals {
  rounds: number;
  chatWins: number;
  codexWins: number;
  unawarded: number;
  byInput: Record<SeasonInput, number>;
}
export interface SeasonScoreboard {
  schemaVersion: 1;
  roundIds: string[];
  viewers: SeasonTotals;
  tests: SeasonTotals & { fixtures: number; broadcasterTests: number };
}
export type SeasonReceipt = Pick<
  ReturnType<typeof publicReceipt>,
  "roundId" | "mode" | "trigger" | "input" | "winner" | "autopsy" | "events"
>;

function empty(): SeasonTotals {
  return {
    rounds: 0,
    chatWins: 0,
    codexWins: 0,
    unawarded: 0,
    byInput: {
      chat: 0,
      "channel-points": 0,
      whisper: 0,
      raid: 0,
      "power-up": 0,
      unknown: 0,
    },
  };
}

/** Count receipt winners, never a successful repair or a session's cumulative score. */
export function deriveSeason(
  receipts: readonly SeasonReceipt[],
): SeasonScoreboard {
  const result: SeasonScoreboard = {
    schemaVersion: 1,
    roundIds: [],
    viewers: empty(),
    tests: { ...empty(), fixtures: 0, broadcasterTests: 0 },
  };
  const seen = new Set<string>();
  for (const receipt of [...receipts].sort((a, b) =>
    a.roundId.localeCompare(b.roundId),
  )) {
    if (seen.has(receipt.roundId))
      throw new Error(`Duplicate season round: ${receipt.roundId}`);
    seen.add(receipt.roundId);
    result.roundIds.push(receipt.roundId);
    const test =
      receipt.trigger === "broadcaster-test" ||
      receipt.autopsy?.trigger === "broadcaster-test" ||
      receipt.events.some((event) => event.trigger === "broadcaster-test");
    const viewer = receipt.mode === "live-twitch" && !test;
    const group = viewer ? result.viewers : result.tests;
    group.rounds++;
    if (receipt.winner === "chat") group.chatWins++;
    else if (receipt.winner === "codex") group.codexWins++;
    else if (receipt.winner === null) group.unawarded++;
    else throw new Error(`Invalid season winner: ${receipt.roundId}`);
    const input = receipt.input ?? "unknown";
    if (!SEASON_INPUTS.includes(input))
      throw new Error(`Invalid season input: ${receipt.roundId}`);
    group.byInput[input]++;
    if (!viewer) {
      if (receipt.mode !== "live-twitch") result.tests.fixtures++;
      else result.tests.broadcasterTests++;
    }
  }
  return result;
}

/** Only viewer totals cross the overlay boundary. Test wins never become season wins. */
export function parseViewerSeason(value: unknown): SeasonTotals {
  if (!value || typeof value !== "object")
    throw new Error("Invalid viewer season");
  const row = value as SeasonTotals;
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0;
  if (
    ![row.rounds, row.chatWins, row.codexWins, row.unawarded].every(count) ||
    !row.byInput ||
    !SEASON_INPUTS.every((input) => count(row.byInput[input])) ||
    row.chatWins + row.codexWins + row.unawarded !== row.rounds ||
    SEASON_INPUTS.reduce((sum, input) => sum + row.byInput[input], 0) !==
      row.rounds
  )
    throw new Error("Invalid viewer season");
  return {
    rounds: row.rounds,
    chatWins: row.chatWins,
    codexWins: row.codexWins,
    unawarded: row.unawarded,
    byInput: Object.fromEntries(
      SEASON_INPUTS.map((input) => [input, row.byInput[input]]),
    ) as Record<SeasonInput, number>,
  };
}

export function seasonLine(value: SeasonTotals): string {
  const row = parseViewerSeason(value);
  return `SEASON · CHAT ${row.chatWins} : CODEX ${row.codexWins}`;
}
