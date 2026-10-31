import { describe, expect, it } from "vitest";
import { createState } from "../../sim/src/index.js";
import { compareReplay, type ReplayResult } from "../src/evidence.js";
import { runBounded } from "../src/process.js";

function result(x: number, frame = 60, alive = true): ReplayResult {
  return {
    hashes: [{ frame, hash: `${x}` }],
    outcome: { x, y: 0, alive, won: false, frame },
    samples: [
      { x, y: 0, alive, won: false, frame, stateHash: `${x}:${alive}` },
    ],
    final: { ...createState(), frame, x, alive },
  };
}

describe("offline gates", () => {
  it("requires a visible displacement greater than 32 pixels within 10 seconds", () => {
    expect(
      compareReplay("track", result(0), result(32 * 256)).visibleFrame,
    ).toBeNull();
    expect(
      compareReplay("track", result(0), result(33 * 256)).visibleFrame,
    ).toBe(60);
    expect(
      compareReplay("track", result(0, 601), result(33 * 256, 601))
        .visibleFrame,
    ).toBeNull();
    expect(
      compareReplay("track", result(0), result(0, 60, false)).visibleFrame,
    ).toBe(60);
  });
  it("does not equate killed with visible, and rejects missing evidence", () => {
    expect(compareReplay("track", result(0), result(1))).toMatchObject({
      failed: true,
      visibleFrame: null,
    });
    expect(compareReplay("track", result(0), result(0)).failed).toBe(false);
    expect(() =>
      compareReplay("track", result(0), { ...result(0), samples: [] }),
    ).toThrow();
  });
  it("detects full-state divergence even when positions still match", () => {
    const bugged = result(0);
    if (!bugged.samples[0]) throw new Error("Missing sample");
    bugged.samples[0].stateHash = "different";
    expect(compareReplay("track", result(0), bugged)).toMatchObject({
      firstDivergence: 60,
      visibleFrame: null,
    });
  });
  it("kills an infinite replay process instead of hanging the gate", () => {
    expect(() =>
      runBounded(
        process.execPath,
        ["-e", "while(true) {}"],
        process.cwd(),
        150,
      ),
    ).toThrow(/SIGKILL/);
  });
  it("refuses a failed child even if it prints a success-shaped result", () => {
    expect(() =>
      runBounded(
        process.execPath,
        ["-e", "console.log('passed'); process.exit(1)"],
        process.cwd(),
        1000,
      ),
    ).toThrow();
  });
});
