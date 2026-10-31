import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Receipt } from "../src/evidence.js";
import { RACE_RULE, raceSummary } from "../src/race-summary.js";

function receipt(roundId: string): Receipt {
  return JSON.parse(
    readFileSync(
      new URL(`../../../docs/rounds/${roundId}.json`, import.meta.url),
      "utf8",
    ),
  ) as Receipt;
}

const recomputed = receipt("c81bdc19-304f-47d5-800e-5098b9a1b5e2");
const roundLimit = receipt("c37736fc-52d2-4ca0-9eee-dae78a5eff7b");
const legacy = receipt("65e06ea8-d2bd-4e40-9ec7-79f4318c2b02");

describe("recorded race summary", () => {
  it("shows the verified round's recorded winner and measured head start", () => {
    expect(raceSummary(recomputed)).toEqual({
      winner: "CODEX",
      firstCorrect: "none",
      headStart: "15 s",
    });
  });

  it("keeps the real round-limit loss separate from its completed repair", () => {
    expect(roundLimit.autopsy?.status).toBe("verified");
    expect(roundLimit.reason).toBe("round-limit");
    expect(roundLimit.durations?.timeToGreenMs).toBeGreaterThan(60000);
    expect(raceSummary(roundLimit).winner).toBe("none");
    expect(raceSummary(roundLimit).firstCorrect).toBe("none");
  });

  it("uses measured legacy head start without inventing a missing GREEN time", () => {
    expect(legacy.durations?.timeToGreenMs).toBeNull();
    expect(raceSummary(legacy).headStart).toBe("15 s");
  });

  it("reports unavailable timing when absent instead of assuming 15 seconds", () => {
    for (const headStartMs of [null, Number.NaN, -1])
      expect(
        raceSummary({ ...legacy, durations: { headStartMs } }).headStart,
      ).toBe("unavailable");
    expect(raceSummary({ ...legacy, durations: null }).headStart).toBe(
      "unavailable",
    );
  });

  it("preserves an already sanitized correct guesser when one is recorded", () => {
    const firstCorrectGuesser = recomputed.breaker;
    expect(firstCorrectGuesser).toMatch(/^viewer-[a-f0-9]{16}$/);
    expect(
      raceSummary({ ...recomputed, winner: "chat", firstCorrectGuesser }),
    ).toEqual({
      winner: "CHAT",
      firstCorrect: firstCorrectGuesser,
      headStart: "15 s",
    });
  });

  it("states the three-command race rule without revealing a bug family", () => {
    expect(RACE_RULE).toBe(
      "!break -> !guess <bug> -> first correct guess races Codex.",
    );
  });
});
