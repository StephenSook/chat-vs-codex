import { expect, it } from "vitest";
import { gateEvidence, TRACKS } from "../../../games/breakout/replay.js";
import { parseGateOutput } from "../src/evidence.js";

const output = () =>
  JSON.parse(JSON.stringify({ definitions: TRACKS, evidence: gateEvidence() }));
it("accepts the real replay producer and refuses malformed or incomplete adapter evidence", () => {
  expect(parseGateOutput(output()).definitions).toHaveLength(3);
  const mutations = [
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks = [];
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].samples.pop();
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].samples[0].frame = 2;
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].samples[0].x = Infinity;
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].name = "replacement";
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].hashes = [];
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.tracks[0].outcome.x++;
    },
    (value: ReturnType<typeof output>) => {
      value.evidence.canary.frames = 0;
    },
    (value: ReturnType<typeof output>) => {
      value.definitions[1].name = value.definitions[0].name;
    },
  ];
  for (const mutate of mutations) {
    const value = output();
    mutate(value);
    expect(() => parseGateOutput(value)).toThrow(
      "Invalid replay adapter evidence",
    );
  }
});

it("accepts short terminal canary telemetry but refuses incomplete active telemetry", () => {
  const won = output();
  won.evidence.canary = { frames: 24, alive: true, won: true };
  expect(parseGateOutput(won).evidence.canary).toEqual({
    frames: 24,
    alive: true,
    won: true,
  });
  const dead = output();
  dead.evidence.canary = { frames: 24, alive: false, won: false };
  expect(parseGateOutput(dead).evidence.canary.alive).toBe(false);
  const incomplete = output();
  incomplete.evidence.canary = { frames: 24, alive: true, won: false };
  expect(() => parseGateOutput(incomplete)).toThrow(
    "Invalid replay adapter evidence",
  );
  const absent = output();
  delete absent.evidence.canary.won;
  expect(() => parseGateOutput(absent)).toThrow(
    "Invalid replay adapter evidence",
  );
});
