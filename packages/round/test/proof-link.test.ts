import { describe, expect, it } from "vitest";
import {
  failedRoundMessage,
  fixedRoundMessage,
  JUDGE_URL,
  roundProofUrl,
} from "../src/proof-link.js";

const roundId = "ac8b50c7-1012-4f20-af7e-10dd718b9f1c";
const proof = `${JUDGE_URL}#r=${roundId}`;

describe("result chat proof links", () => {
  it("ends verified result text with its proof without changing the measured split or test credit", () => {
    expect(
      fixedRoundMessage({
        roundId,
        family: "gravity-sign",
        timeToGreenMs: 28470,
        regression: true,
      }),
    ).toBe(`Codex fixed gravity-sign. GREEN 0:28.47 | +1 test ${proof}`);
    expect(
      fixedRoundMessage({
        roundId,
        family: "collision-off-by-one",
        timeToGreenMs: 22090,
        regression: false,
      }),
    ).toBe(`Codex fixed collision-off-by-one. GREEN 0:22.09 ${proof}`);
  });

  it("links failure while retaining truthful rollback status", () => {
    expect(failedRoundMessage({ roundId, reason: "repair-failed" })).toBe(
      `Codex failed. The game was rolled back. ${proof}`,
    );
    for (const reason of ["rollback-failed", "rollback-timeout"])
      expect(failedRoundMessage({ roundId, reason })).toBe(
        `Codex failed. Restore needs attention. ${proof}`,
      );
  });

  it("encodes a supplied ID without changing the destination or adding chat text", () => {
    const link = new URL(roundProofUrl("round#other\nnew text"));
    expect(link.origin).toBe(new URL(JUDGE_URL).origin);
    expect(link.hash).toBe("#r=round%23other%0Anew%20text");
    expect(link.search).toBe("");
  });
});
