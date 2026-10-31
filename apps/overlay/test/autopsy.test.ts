import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoundAutopsy } from "../../../packages/round/src/contracts.js";
import { OrderedRoundBridge, parseRoundEnvelope } from "../src/bridge.js";
import {
  createEventBus,
  initialBroadcast,
  reduceBroadcast,
} from "../src/events.js";
import { renderBroadcast, renderClock } from "../src/hud.js";
import { autopsyView, splitTime } from "../src/presentation.js";
import { SimulationPlayer } from "../src/simulation.js";

export function autopsyFixture(
  overrides: Partial<RoundAutopsy> = {},
): RoundAutopsy {
  return {
    roundId: "autopsy-test",
    status: "verified",
    reason: null,
    breaker: "viewer-0123456789abcdef",
    firstCorrectGuesser: null,
    family: "gravity-sign",
    winner: "codex",
    patch: {
      added: 1,
      removed: 1,
      preview: ["- return vy - GRAVITY;", "+ return vy + GRAVITY;"],
    },
    explanation: "Grounded gravity used the wrong sign.",
    durations: {
      headStartMs: 15000,
      repairMs: 10000,
      validationMs: 2000,
      swapMs: 10,
      timeToGreenMs: 12010,
    },
    previousRoundId: "prior-test",
    deltaMs: -1200,
    ...overrides,
  };
}

const started = () =>
  reduceBroadcast(initialBroadcast(), {
    type: "round.started",
    id: "autopsy-test",
    number: 1,
    atMs: 0,
  });
const wire = (autopsy: RoundAutopsy) => ({
  sequence: 1,
  serverTimeMs: 1,
  event: {
    type: "overlay",
    event: { type: "round.autopsy", roundId: autopsy.roundId, autopsy },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("observed round autopsy", () => {
  it("preserves long producer explanation and source lines through the actual wire without disconnecting", async () => {
    const explanation = `Actual diagnosis: ${"grounded gravity used the wrong sign. ".repeat(100)}`;
    const line = `- const map = ${JSON.stringify("actual source data ".repeat(100))};`;
    const record: RoundAutopsy = autopsyFixture({
      explanation,
      patch: {
        added: 1,
        removed: 1,
        preview: [line, line.replace("- const", "+ const")],
      },
    });
    let state = initialBroadcast();
    const events = createEventBus();
    events.subscribe((event) => {
      state = reduceBroadcast(state, event);
    });
    const onError = vi.fn();
    const bridge = new OrderedRoundBridge({
      simulation: new SimulationPlayer("play"),
      events,
      onError,
      loadBuild: async () => {
        throw new Error("No build should load");
      },
    });
    await bridge.receive({
      sequence: 1,
      serverTimeMs: 1,
      event: {
        type: "overlay",
        event: {
          type: "round.started",
          id: record.roundId,
          number: 1,
          atMs: 1,
        },
      },
    });
    // JSON round-trip exercises the producer/consumer wire rather than bypassing validation.
    await bridge.receive(
      JSON.parse(JSON.stringify({ ...wire(record), sequence: 2 })),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(state.autopsy?.explanation).toBe(explanation);
    expect(state.autopsy?.patch?.preview).toEqual(record.patch?.preview);
    expect(autopsyView(record).diff).toBe(record.patch?.preview.join("\n"));
    expect(autopsyView(record).explanation).toBe(explanation.trim());
  });
  it("delivers an actual preparing-state failure through the ordered bridge without a made-up start", async () => {
    let state = initialBroadcast();
    const events = createEventBus();
    events.subscribe((event) => {
      state = reduceBroadcast(state, event);
    });
    const bridge = new OrderedRoundBridge({
      simulation: new SimulationPlayer("play"),
      events,
      loadBuild: async () => {
        throw new Error("No build should load");
      },
    });
    const record = autopsyFixture({
      status: "rolled-back",
      reason: "prepare-failed",
    });
    await bridge.receive({
      sequence: 1,
      serverTimeMs: 1,
      event: {
        type: "round.state",
        phase: "preparing",
        roundId: record.roundId,
        headStartEndsAt: null,
        winner: null,
        reason: null,
      },
    });
    await bridge.receive({ ...wire(record), sequence: 2 });
    expect(state.autopsy).toEqual(record);
    expect(state.startedAtMs).toBeNull();
    expect(state.steps).toEqual([]);
    expect(state.round).toBe(0);
  });
  it("retains preparation-only failures without inventing a start, timer or activity", () => {
    const preparing = reduceBroadcast(started(), {
      type: "round.preparing",
      id: "not-started",
    });
    expect(preparing).toMatchObject({
      roundId: "not-started",
      round: 0,
      startedAtMs: null,
      steps: [],
    });
    const record = autopsyFixture({
      roundId: "not-started",
      status: "rolled-back",
      reason: "prepare-failed",
    });
    const state = reduceBroadcast(preparing, {
      type: "round.autopsy",
      roundId: record.roundId,
      autopsy: record,
    });
    expect(state.autopsy).toBe(record);
    expect(state.startedAtMs).toBeNull();
    expect(state.steps).toEqual([]);
    expect(state.chat + state.codex).toBe(0);
  });

  it("formats LiveSplit-style hundredths across minute boundaries", () => {
    expect(splitTime(0)).toBe("0:00.00");
    expect(splitTime(59999)).toBe("1:00.00");
    expect(splitTime(123456)).toBe("2:03.46");
    expect(autopsyView(autopsyFixture({ deltaMs: 1200 })).trend).toBe("slower");
  });
  it("opens only from the terminal record, preserves scores, and clears on a new round", () => {
    const active = started();
    expect(active.autopsy).toBeNull();
    const record = autopsyFixture();
    const state = reduceBroadcast(active, {
      type: "round.autopsy",
      roundId: record.roundId,
      autopsy: record,
    });
    expect(state.autopsy).toBe(record);
    expect(state.chat + state.codex).toBe(0);
    expect(state.bug).toBe("none");
    expect(
      reduceBroadcast(state, {
        type: "round.started",
        id: "next",
        number: 2,
        atMs: 1000,
      }).autopsy,
    ).toBeNull();
    expect(
      reduceBroadcast(active, {
        type: "round.autopsy",
        roundId: "old",
        autopsy: { ...record, roundId: "old" },
      }),
    ).toBe(active);
  });

  it("formats actual phase splits, actual diff text and a signed prior-green delta", () => {
    const record = autopsyFixture();
    const view = autopsyView(record);
    expect(view.verdict).toBe("CODEX FIXED IT");
    expect(view.green).toBe("GREEN 0:12.01");
    expect(view.splits).toEqual([
      "HEAD START 15.00s",
      "REPAIR 10.00s",
      "TESTS 2.00s",
      "SWAP 0.01s",
    ]);
    expect(view.diff).toBe(record.patch?.preview.join("\n"));
    expect(view.delta).toBe("-0:01.20 vs previous");
    expect(view.trend).toBe("faster");
    expect(autopsyView(autopsyFixture({ deltaMs: 1200 })).delta).toBe(
      "+0:01.20 vs previous",
    );
    expect(
      autopsyView(
        autopsyFixture({
          winner: "chat",
          firstCorrectGuesser: "viewer-1111111111111111",
        }),
      ).verdict,
    ).toBe("CHAT FOUND IT");
  });

  it("labels missing measurements and rollback failures without manufacturing a green", () => {
    const missing = autopsyView(
      autopsyFixture({
        status: "rolled-back",
        reason: "rollback-failed",
        family: null,
        patch: null,
        explanation: null,
        breaker: null,
        durations: {
          headStartMs: null,
          repairMs: null,
          validationMs: null,
          swapMs: null,
          timeToGreenMs: null,
        },
        previousRoundId: null,
        deltaMs: null,
      }),
    );
    expect(missing.verdict).toBe("RESTORE FAILED");
    expect(missing.diff).toBe("Diff unavailable");
    expect(missing.green).toBe("NO VERIFIED GREEN");
    expect(missing.splits.every((line) => line.includes("Not measured"))).toBe(
      true,
    );
    expect(missing.delta).toBe("Previous split unavailable");
    expect(missing.breaker).toBe("BREAK: Not recorded");
    expect(missing.guesser).toBe("FOUND: No correct guess");
  });

  it("accepts the producer's typed receipt and refuses raw identities or excessive diff line counts", () => {
    expect(parseRoundEnvelope(wire(autopsyFixture())).event.type).toBe(
      "overlay",
    );
    for (const record of [
      autopsyFixture({ breaker: "123456789" }),
      autopsyFixture({ firstCorrectGuesser: "real-user-name" }),
      autopsyFixture({
        patch: { added: 3, removed: 2, preview: Array(5).fill("+ line") },
      }),
      autopsyFixture({
        durations: { ...autopsyFixture().durations, repairMs: -1 },
      }),
    ]) {
      expect(() => parseRoundEnvelope(wire(record))).toThrow(
        "Invalid round event",
      );
    }
  });

  it("sends untrusted explanation and diff only through text nodes and replaces the right dock", () => {
    class Element {
      hidden = false;
      textContent: string | null = "";
      title = "";
      className = "";
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      children: Element[] = [];
      set innerHTML(_value: string) {
        throw new Error("Unsafe HTML sink");
      }
      replaceChildren() {
        this.children = [];
      }
      append(...children: Element[]) {
        this.children.push(...children);
      }
      setAttribute() {}
    }
    const elements = new Map<string, Element>();
    vi.stubGlobal("document", {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement(tag: string) {
        expect(["li", "span"]).toContain(tag);
        return new Element();
      },
    });
    const payload = '<img src=x onerror="bad()">';
    const record = autopsyFixture({
      explanation: payload,
      patch: { added: 1, removed: 1, preview: [`- ${payload}`, "+ safe"] },
    });
    const state = reduceBroadcast(started(), {
      type: "round.autopsy",
      roundId: record.roundId,
      autopsy: record,
    });
    renderBroadcast(state);
    renderClock(state, 1000);
    expect(elements.get("autopsy-explanation")?.textContent).toBe(payload);
    expect(elements.get("autopsy-diff")?.textContent).toContain(payload);
    expect(elements.get("autopsy")?.hidden).toBe(false);
    expect(elements.get("ticker")?.hidden).toBe(true);
    expect(elements.get("countdown")?.hidden).toBe(true);
    expect(elements.get("fuse")?.hidden).toBe(true);
    const html = readFileSync(
      new URL("../index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain('id="autopsy"');
    expect(html).toContain('aria-label="Round autopsy" hidden');
  });
});
