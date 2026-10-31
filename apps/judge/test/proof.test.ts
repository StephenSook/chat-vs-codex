import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HELD_OUT, runTrack } from "../../../packages/replay/src/index.js";
import * as game from "../../../packages/sim/src/index.js";
import {
  greenSplit,
  isEarlierTestRound,
  type Receipt,
  roundLabel,
} from "../src/evidence.js";
import {
  loadVerifiedGame,
  proofAvailability,
  replayProof,
  sha256,
} from "../src/proof.js";

// Real producer output, rather than a fixture shaped around the consumer.
const receipt = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/rounds/1b4285af-fd5a-42a1-ad46-038d72959f96.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Receipt;
const replay = {
  artifactPath: "evidence/game.js",
  buildDigest: receipt.validationReplay?.buildDigest ?? "",
  track: HELD_OUT,
};

describe("browser proof", () => {
  it("re-simulates the producer's actual held-out route and matches its recorded frame digest", async () => {
    const computed = await replayProof(game, replay, receipt);
    expect(computed.frames).toEqual(runTrack(HELD_OUT).samples);
    expect(computed.framesDigest).toBe(receipt.validationReplay?.framesDigest);
  });

  it("refuses a different build, a legacy receipt, and a missing installation binding", () => {
    expect(proofAvailability(receipt, "a".repeat(64))).toContain(
      "not in this static",
    );
    expect(
      proofAvailability(
        { ...receipt, validationReplay: null },
        replay.buildDigest,
      ),
    ).toContain("legacy");
    expect(
      proofAvailability(
        { ...receipt, verification: { ...receipt.verification, builds: [] } },
        replay.buildDigest,
      ),
    ).toContain("installation");
  });

  it("refuses track and frame digest mismatches without claiming a proof", async () => {
    await expect(
      replayProof(
        game,
        { ...replay, track: { ...HELD_OUT, seed: 0 } },
        receipt,
      ),
    ).rejects.toThrow("track digest");
    if (!receipt.validationReplay)
      throw new Error("Test needs real frame evidence");
    await expect(
      replayProof(game, replay, {
        ...receipt,
        validationReplay: {
          ...receipt.validationReplay,
          framesDigest: "f".repeat(64),
        },
      }),
    ).rejects.toThrow("do not match");
  });

  it("checks downloaded bytes before importing and revokes its verified blob URL", async () => {
    const bytes = new TextEncoder().encode("export const proof = true;");
    const importer = vi.fn(async (_url: string) => game);
    await expect(
      loadVerifiedGame(bytes, "b".repeat(64), importer),
    ).rejects.toThrow("artifact SHA-256");
    expect(importer).not.toHaveBeenCalled();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    expect(await loadVerifiedGame(bytes, await sha256(bytes), importer)).toBe(
      game,
    );
    expect(importer.mock.calls[0]?.[0]).toMatch(/^blob:/);
    expect(revoke).toHaveBeenCalledOnce();
    revoke.mockRestore();
  });

  it("groups only receipts without a measured green split and captured diff as earlier tests", () => {
    const legacy = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/rounds/65e06ea8-d2bd-4e40-9ec7-79f4318c2b02.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Receipt;
    expect(isEarlierTestRound(legacy)).toBe(true);
    expect(isEarlierTestRound(receipt)).toBe(false);
    expect(isEarlierTestRound({ ...receipt, autopsy: null })).toBe(false);
    expect(
      isEarlierTestRound({ ...receipt, durations: legacy.durations }),
    ).toBe(false);
  });

  it("keeps broadcaster tests distinct from viewer and fixture rounds", () => {
    expect(roundLabel(receipt)).toBe("LOCAL ROUND / FIXTURE");
    expect(roundLabel({ ...receipt, mode: "live-twitch" })).toBe(
      "TWITCH CHAT ROUND / VIEWER",
    );
    expect(
      roundLabel({
        ...receipt,
        mode: "live-twitch",
        trigger: "broadcaster-test",
      }),
    ).toBe("TWITCH CHAT ROUND / TEST");
    expect(
      roundLabel({
        ...receipt,
        mode: "live-twitch",
        events: [
          {
            sequence: 1,
            trigger: "broadcaster-test",
            type: "round.state",
            atMs: 1,
            wallTime: "2026-10-31T00:00:00.000Z",
          },
        ],
      }),
    ).toBe("TWITCH CHAT ROUND / TEST");
    expect(greenSplit(23968.98)).toBe("GREEN 0:23.97");
    expect(greenSplit(null)).toBe("GREEN unavailable");
  });
});
