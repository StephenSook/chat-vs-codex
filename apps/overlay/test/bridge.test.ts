import { createState, hashState, step } from "@chat-vs-codex/sim";
import { describe, expect, it, vi } from "vitest";
import type {
  RoundEnvelope,
  RoundEvent,
} from "../../../packages/round/src/contracts.js";
import {
  bridgeOrigin,
  loadVerifiedBuild,
  OrderedRoundBridge,
  parseRoundEnvelope,
} from "../src/bridge.js";
import { createEventBus, type OverlayEvent } from "../src/events.js";
import { FRAME_MS, SimulationPlayer } from "../src/simulation.js";

const envelope = (
  sequence: number,
  event: RoundEvent,
  serverTimeMs = 100000,
): RoundEnvelope => ({ sequence, serverTimeMs, event });
const preparing = (roundId: string): RoundEvent => ({
  type: "round.state",
  phase: "preparing",
  roundId,
  headStartEndsAt: null,
  winner: null,
  reason: null,
});
const started = (id: string, atMs = 100000): RoundEvent => ({
  type: "overlay",
  event: { type: "round.started", id, number: 1, atMs },
});
const build = (
  roundId: string,
): Extract<RoundEvent, { type: "game.build" }> => ({
  type: "game.build",
  roundId,
  buildId: "a".repeat(64),
  digest: "a".repeat(64),
  phase: "broken",
});
const module = { createState, hashState, step };

function fixture(
  loadBuild: (
    event: Extract<RoundEvent, { type: "game.build" }>,
  ) => Promise<unknown> = vi.fn(async () => module),
) {
  const simulation = new SimulationPlayer("play");
  const events = createEventBus();
  const received: OverlayEvent[] = [];
  events.subscribe((event) => received.push(event));
  const onError = vi.fn();
  const bridge = new OrderedRoundBridge({
    simulation,
    events,
    loadBuild,
    now: () => 5000,
    onError,
  });
  return { simulation, bridge, received, loadBuild, onError };
}

describe("ordered round bridge", () => {
  it("installs the broken module before later overlay activity, preserving the live frame", async () => {
    let resolve!: (value: typeof module) => void;
    const loading = new Promise<typeof module>((done) => {
      resolve = done;
    });
    const f = fixture(vi.fn(() => loading));
    f.simulation.advance(FRAME_MS, 2);
    const state = f.simulation.state;
    await f.bridge.receive(envelope(1, preparing("r")));
    const importDone = f.bridge.receive(envelope(2, build("r")));
    const startDone = f.bridge.receive(envelope(3, started("r")));
    const bugDone = f.bridge.receive(
      envelope(4, {
        type: "overlay",
        event: { type: "bug.active", roundId: "r", intensity: 0.7 },
      }),
    );
    await Promise.resolve();
    expect(f.received).toEqual([]);
    resolve(module);
    await Promise.all([importDone, startDone, bugDone]);
    expect(f.simulation.state).toBe(state);
    expect(f.received.map((event) => event.type)).toEqual([
      "round.started",
      "bug.active",
    ]);
  });

  it("converts legacy server time at receipt, including late reconnect replay", async () => {
    const f = fixture();
    await f.bridge.receive(envelope(7, started("r", 96000), 100000));
    expect(f.received[0]).toMatchObject({ type: "round.started", atMs: 1000 });
    await f.bridge.receive(envelope(7, started("r", 96000), 100000));
    await f.bridge.receive(envelope(6, started("old"), 100000));
    expect(f.received).toHaveLength(1);
  });

  it("uses fresh monotonic delivery time on reconnect while preserving original event evidence clocks", async () => {
    const f = fixture();
    const original: RoundEnvelope = {
      ...envelope(7, started("r", 96000), 100000),
      atMs: 100000,
      wallTime: "2026-10-31T12:00:00.000Z",
      deliveryAtMs: 110000,
    };
    await f.bridge.receive(original);
    expect(f.received[0]).toMatchObject({ type: "round.started", atMs: -9000 });
    expect(original.atMs).toBe(100000);
    expect(original.serverTimeMs).toBe(100000);
    const earlier = fixture();
    await earlier.bridge.receive({
      ...original,
      deliveryAtMs: undefined,
      atMs: 102000,
    });
    expect(earlier.received[0]).toMatchObject({
      type: "round.started",
      atMs: -1000,
    });
    for (const key of ["deliveryAtMs", "atMs"] as const)
      expect(() =>
        parseRoundEnvelope({ ...original, [key]: Number.NaN }),
      ).toThrow("clock");
  });

  it("suppresses an old round's slow import and events after a newer round arrives", async () => {
    let resolve!: (value: typeof module) => void;
    const f = fixture(
      vi.fn(
        () =>
          new Promise<typeof module>((done) => {
            resolve = done;
          }),
      ),
    );
    await f.bridge.receive(envelope(1, preparing("old")));
    const pending = f.bridge.receive(envelope(2, build("old")));
    await Promise.resolve();
    const newest = f.bridge.receive(envelope(3, started("new")));
    resolve(module);
    await Promise.all([pending, newest]);
    await f.bridge.receive(
      envelope(4, {
        type: "overlay",
        event: { type: "tests.green", roundId: "old" },
      }),
    );
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ type: "round.started", id: "new" });
  });

  it("discards obsolete import failures and old unscoped scores queued behind them", async () => {
    let reject!: (error: Error) => void;
    const f = fixture(
      vi.fn(
        () =>
          new Promise((_resolve, failed) => {
            reject = failed;
          }),
      ),
    );
    await f.bridge.receive(envelope(1, preparing("old")));
    const pending = f.bridge.receive(envelope(2, build("old")));
    await Promise.resolve();
    const score = f.bridge.receive(
      envelope(3, {
        type: "overlay",
        event: { type: "score.changed", chat: 8, codex: 4 },
      }),
    );
    const next = f.bridge.receive(envelope(4, started("next")));
    reject(new Error("old request failed"));
    await Promise.all([pending, score, next]);
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.received).toHaveLength(1);
    expect(f.received[0]).toMatchObject({ type: "round.started", id: "next" });
  });

  it("does not move the countdown start forward while waiting for a build import", async () => {
    let now = 5000;
    let resolve!: (value: typeof module) => void;
    const received: OverlayEvent[] = [];
    const events = createEventBus();
    events.subscribe((event) => received.push(event));
    const bridge = new OrderedRoundBridge({
      simulation: new SimulationPlayer("play"),
      events,
      now: () => now,
      loadBuild: () =>
        new Promise<typeof module>((done) => {
          resolve = done;
        }),
    });
    await bridge.receive(envelope(1, preparing("r")));
    const loading = bridge.receive(envelope(2, build("r")));
    await Promise.resolve();
    const start = bridge.receive(envelope(3, started("r")));
    now = 9000;
    resolve(module);
    await Promise.all([loading, start]);
    expect(received[0]).toMatchObject({ type: "round.started", atMs: 5000 });
  });

  it("keeps the previous module and suppresses green/score after a local build failure", async () => {
    const f = fixture(vi.fn(async () => ({ step })));
    await f.bridge.receive(envelope(1, started("r")));
    const before = f.simulation.state;
    await expect(f.bridge.receive(envelope(2, build("r")))).rejects.toThrow(
      "missing simulation exports",
    );
    await f.bridge.receive(
      envelope(3, {
        type: "overlay",
        event: { type: "tests.green", roundId: "r" },
      }),
    );
    await f.bridge.receive(
      envelope(4, {
        type: "overlay",
        event: { type: "score.changed", chat: 0, codex: 1 },
      }),
    );
    expect(f.simulation.state).toBe(before);
    expect(f.received).toHaveLength(1);
    expect(f.onError).toHaveBeenCalledOnce();
    await f.bridge.receive(envelope(5, started("next")));
    expect(f.received).toHaveLength(2);
  });

  it("reports sequence gaps and refuses malformed event payloads", async () => {
    const f = fixture();
    await f.bridge.receive(envelope(1, started("r")));
    await expect(
      f.bridge.receive(
        envelope(3, {
          type: "overlay",
          event: { type: "tests.green", roundId: "r" },
        }),
      ),
    ).rejects.toThrow("sequence gap");
    expect(() =>
      parseRoundEnvelope({
        sequence: 1,
        serverTimeMs: 1,
        event: { type: "overlay", event: { type: "codex.step" } },
      }),
    ).toThrow("Invalid round event");
    f.bridge.close();
    await f.bridge.receive(
      envelope(2, {
        type: "overlay",
        event: { type: "tests.green", roundId: "r" },
      }),
    );
    expect(f.received).toHaveLength(1);
  });
});

describe("artifact integrity", () => {
  it("accepts only the fixed activity vocabulary from the round wire", () => {
    const event = {
      type: "overlay",
      event: {
        type: "codex.step",
        roundId: "r",
        id: "item",
        step: { kind: "activity", action: "edit-test" },
        status: "done",
        attempt: 1,
        total: 1,
      },
    };
    expect(
      parseRoundEnvelope({ sequence: 1, serverTimeMs: 1, event }).event,
    ).toEqual(event);
    expect(() =>
      parseRoundEnvelope({
        sequence: 1,
        serverTimeMs: 1,
        event: {
          ...event,
          event: {
            ...event.event,
            step: { kind: "activity", action: "private free text" },
          },
        },
      }),
    ).toThrow("Invalid round event");
  });
  it("checks SHA-256 bytes before importing and rejects a corrupted response", async () => {
    const code = "export const marker = 1;";
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const artifact = { ...build("r"), buildId: digest, digest };
    const importModule = vi.fn(async () => module);
    const fetchBuild = vi.fn(
      async () => new Response(code),
    ) as unknown as typeof fetch;
    expect(
      await loadVerifiedBuild("http://127.0.0.1:4317", artifact, {
        fetch: fetchBuild,
        importModule,
      }),
    ).toBe(module);
    expect(importModule).toHaveBeenCalledWith(code);
    importModule.mockClear();
    await expect(
      loadVerifiedBuild("http://127.0.0.1:4317", artifact, {
        fetch: vi.fn(
          async () => new Response(`${code} `),
        ) as unknown as typeof fetch,
        importModule,
      }),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(importModule).not.toHaveBeenCalled();
    expect(() => bridgeOrigin("https://evil.example")).toThrow("loopback");
  });
});
