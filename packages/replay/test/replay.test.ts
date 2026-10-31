import { readFileSync } from "node:fs";
import { step } from "@chat-vs-codex/sim";
import { describe, expect, it } from "vitest";
import {
  CANARY,
  expand,
  goldenResult,
  HELD_OUT,
  MAX_FRAMES,
  runTrack,
  TRACKS,
} from "../src/index.js";

const goldens: Record<string, ReturnType<typeof goldenResult>> = JSON.parse(
  readFileSync(new URL("../fixtures/goldens.json", import.meta.url), "utf8"),
);
describe("recorded deterministic replays", () => {
  it("records full-state divergence even before a position changes", () => {
    const track = { name: "counter-only", seed: 13, inputs: [0] };
    const normal = runTrack(track);
    const changed = runTrack(track, (state, input) => ({
      ...step(state, input),
      buffer: 1,
    }));
    expect(changed.outcome).toEqual(normal.outcome);
    expect(changed.samples[0]?.stateHash).not.toBe(
      normal.samples[0]?.stateHash,
    );
  });
  for (const track of TRACKS) {
    it(`${track.name} matches each 60-frame hash and final outcome`, () => {
      expect(goldenResult(track)).toEqual(goldens[track.name]);
      expect(runTrack(track).final.won).toBe(true);
    });
  }
  it("actually consumes the buffered press before landing", () => {
    const track = TRACKS.find(
      (candidate) => candidate.name === "buffered-landing",
    );
    if (!track) throw new Error("Missing buffer track");
    expect(runTrack(track).final.bufferedJumps).toBeGreaterThan(0);
  });
  it("actually lands partly over the moving platform's edge", () => {
    const track = TRACKS.find((candidate) => candidate.name === "moving-edge");
    if (!track) throw new Error("Missing edge track");
    expect(runTrack(track).final.edgeLandings).toBeGreaterThan(0);
  });
  it("survives 20 seconds without a terminal-state shortcut", () => {
    const result = runTrack(CANARY);
    expect(result.final.alive).toBe(true);
    expect(result.final.won).toBe(false);
    expect(result.final.frame).toBe(1200);
  });
  it("has a separate successful held-out timing", () => {
    expect(runTrack(HELD_OUT).final.won).toBe(true);
  });
  it("refuses invalid and oversized input tracks", () => {
    expect(() => runTrack({ name: "empty", seed: 0, inputs: [] })).toThrow(
      "frame budget",
    );
    expect(() =>
      runTrack({
        name: "long",
        seed: 0,
        inputs: Array<number>(MAX_FRAMES + 1).fill(0),
      }),
    ).toThrow("frame budget");
    expect(() => runTrack({ name: "invalid", seed: 0, inputs: [8] })).toThrow(
      "input mask",
    );
    expect(() => expand([-1, 0])).toThrow("frame count");
  });
});
