import { describe, expect, it } from "vitest";
import type { RoundEnvelope, RoundEvent } from "../src/contracts.js";
import {
  PublicRoundProjection,
  parsePublicRoundState,
} from "../src/public-state.js";
import { deriveSeason } from "../src/season.js";
import { startRoundServer } from "../src/server.js";

const wall = "2026-10-31T18:00:00.000Z";
const envelope = (event: RoundEvent): RoundEnvelope => ({
  event,
  sequence: 1,
  serverTimeMs: 1000,
  atMs: 1000,
  wallTime: wall,
});
const preparing: RoundEvent = {
  type: "round.state",
  roundId: "round",
  phase: "preparing",
  headStartEndsAt: null,
  winner: null,
  reason: null,
};

describe("public Extension state", () => {
  it("rounds fractional monotonic clocks to a valid epoch deadline and clears it on the next preparation", () => {
    const projection = new PublicRoundProjection({ mode: "live-twitch" });
    projection.observe(envelope(preparing));
    projection.observe({
      ...envelope({
        ...preparing,
        phase: "head-start",
        headStartEndsAt: 16000.125,
      }),
      serverTimeMs: 1000.875,
      atMs: 1000.875,
    });
    const state = projection.snapshot(wall);
    expect(state.headStartEndsAt).toBe(Date.parse(wall) + 14999);
    expect(Number.isSafeInteger(state.headStartEndsAt)).toBe(true);
    projection.observe(envelope({ ...preparing, roundId: "next-round" }));
    expect(projection.snapshot(wall)).toMatchObject({
      phase: "preparing",
      headStartEndsAt: null,
      step: null,
    });
  });
  it("uses real producer events and viewer season without actors, answers, source or private telemetry", () => {
    const projection = new PublicRoundProjection({
      mode: "live-twitch",
      trigger: "broadcaster-test",
    });
    projection.observe(envelope(preparing));
    projection.observe(
      envelope({
        type: "overlay",
        event: {
          type: "round.started",
          id: "round",
          number: 2,
          atMs: 1000,
          headStartMs: 15000,
        },
      }),
    );
    projection.observe(
      envelope({
        ...preparing,
        phase: "head-start",
        headStartEndsAt: 16000,
        reason: "private username, secret, family",
      }),
    );
    projection.observe(
      envelope({
        type: "overlay",
        event: {
          type: "codex.step",
          roundId: "round",
          id: "real-sdk-item",
          step: { kind: "reading", path: "/private/workspace/physics.ts" },
          status: "running",
          attempt: 0,
          total: 0,
        },
      }),
    );
    const state = projection.snapshot(wall);
    expect(state).toMatchObject({
      mode: "broadcaster-test",
      round: 2,
      phase: "head-start",
      headStartEndsAt: Date.parse(wall) + 15000,
      step: { label: "Reading physics.ts", status: "running" },
    });
    expect(JSON.stringify(state)).not.toMatch(
      /private|username|secret|family|real-sdk-item/,
    );
    expect(state.season).toEqual(deriveSeason([]).viewers);
    projection.observe(
      envelope({
        type: "overlay",
        event: {
          type: "codex.step",
          roundId: "old-round",
          id: "old",
          step: { kind: "tests" },
          status: "running",
          attempt: 0,
          total: 0,
        },
      }),
    );
    expect(projection.snapshot(wall).step?.label).toBe("Reading physics.ts");
    projection.observe(
      envelope({
        type: "overlay",
        event: { type: "tests.green", roundId: "round" },
      }),
    );
    expect(projection.snapshot(wall).step).toEqual({
      label: "Tests green",
      status: "done",
    });
  });
  it("parser strips unrecognized fields and refuses invalid clocks, counts and season", () => {
    const state = new PublicRoundProjection().snapshot(wall);
    expect(
      parsePublicRoundState({ ...state, token: "never-propagate" }),
    ).toEqual(state);
    for (const changed of [
      { round: -1 },
      { updatedAt: "not-time" },
      { phase: "invented" },
      { headStartEndsAt: Number.NaN },
      { scores: { chat: 1.5, codex: 0 } },
      { season: { ...state.season, chatWins: 3 } },
    ])
      expect(() => parsePublicRoundState({ ...state, ...changed })).toThrow(
        "Invalid",
      );
  });
  it("HTTP snapshot and callback share the exact real server projection", async () => {
    const states: unknown[] = [];
    const server = await startRoundServer({
      session: { mode: "live-twitch" },
      publicState: (state) => states.push(state),
      now: () => 1000,
    });
    try {
      expect(new URL(server.origin).port).not.toBe("4317");
      server.publish(preparing);
      server.publish({
        type: "overlay",
        event: { type: "score.changed", chat: 2, codex: 3 },
      });
      const response = await fetch(`${server.origin}/api/public-state`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const state = parsePublicRoundState(await response.json());
      expect(state).toMatchObject({
        scores: { chat: 2, codex: 3 },
        phase: "preparing",
      });
      expect({ ...state, updatedAt: null }).toEqual({
        ...(states.at(-1) as object),
        updatedAt: null,
      });
      const updated = deriveSeason([]).viewers;
      server.updateSeason(updated);
      expect(states.at(-1)).toMatchObject({ season: updated });
    } finally {
      await server.close();
    }
  });
});
