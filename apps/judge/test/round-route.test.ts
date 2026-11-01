import { describe, expect, it } from "vitest";
import { roundProofUrl } from "../../../packages/round/src/proof-link.js";
import { parseRoundHash } from "../src/round-route.js";

const roundId = "ac8b50c7-1012-4f20-af7e-10dd718b9f1c";

describe("committed round deep links", () => {
  it("round-trips the exact fragment sent in the result message", () => {
    expect(
      parseRoundHash(new URL(roundProofUrl(roundId)).hash, [roundId]),
    ).toBe(roundId);
  });

  it("leaves unknown receipts, malformed fragments and ordinary anchors alone", () => {
    for (const hash of [
      "",
      "#replay",
      "#rounds",
      "#r=",
      "#r=unknown",
      `#r=${roundId}&extra=true`,
      `#r=${roundId}#replay`,
      `#r=${roundId.toUpperCase()}`,
      `#r=%61${roundId.slice(1)}`,
      "#r=../.local/twitch/tokens.json",
    ])
      expect(parseRoundHash(hash, [roundId])).toBeNull();
    expect(parseRoundHash(`#r=${roundId}`, [])).toBeNull();
    expect(parseRoundHash(`#r=${roundId}`, ["another-round"])).toBeNull();
  });
});
