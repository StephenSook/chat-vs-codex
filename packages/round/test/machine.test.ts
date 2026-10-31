import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialBroadcast,
  reduceBroadcast,
} from "../../../apps/overlay/src/events.js";
import type { ClientSnapshot } from "../src/client.js";
import {
  type GameArtifact,
  type MachineLoad,
  type RoundEvent,
  validMachineLoad,
} from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { sampleMachine } from "../src/machine.js";
import { publicReceipt } from "../src/receipt.js";

const wallTime = "2026-10-31T18:00:00.000Z";
const sample = (load1m = 9): MachineLoad => ({
  load1m,
  coreCount: 8,
  busy: load1m > 8,
  atMs: 1000,
  wallTime,
});
const artifact = (id: string): GameArtifact => ({
  id: id.repeat(64),
  code: "fixture game source",
  digest: id.repeat(64),
});
const engines: RoundEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.stop()));
  vi.useRealTimers();
});

describe("round CPU load advisory", () => {
  it.each([
    [7.9, false],
    [8, false],
    [8.1, true],
  ] as const)(
    "measures 1-minute load %s against logical cores and reports busy=%s",
    (load, busy) => {
      expect(
        sampleMachine({
          loadavg: () => [load, 999, 999],
          cpus: () => Array.from({ length: 8 }),
          now: () => 1000,
          wallTime: () => wallTime,
        }),
      ).toEqual(sample(load));
      expect(sample(load).busy).toBe(busy);
    },
  );
  it("refuses malformed wire samples and inconsistent threshold claims", () => {
    expect(validMachineLoad(sample())).toBe(true);
    for (const change of [
      { load1m: Number.NaN },
      { load1m: Number.POSITIVE_INFINITY },
      { load1m: -1 },
      { coreCount: 0 },
      { coreCount: 1.5 },
      { busy: false },
      { atMs: -1 },
      { wallTime: "missing clock" },
      { username: "never-public" },
    ])
      expect(validMachineLoad({ ...sample(), ...change })).toBe(false);
  });
  it("samples every admitted round, publishes after preparing, repairs normally, and preserves measurement in the public receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(wallTime);
    const events: RoundEvent[] = [];
    const inspectMachine = vi
      .fn()
      .mockReturnValueOnce(sample())
      .mockReturnValueOnce(sample(2));
    const repair = vi.fn(async () => artifact("c"));
    const engine = new RoundEngine({
      headStartMs: 0,
      now: () => 1000,
      inspectMachine,
      runtime: {
        prepare: async () => ({
          family: "gravity-sign",
          clean: artifact("a"),
          broken: artifact("b"),
          repair,
          close: async () => {},
        }),
      },
      activate: async () => {},
      publish: (event) => events.push(event),
    });
    engines.push(engine);
    const request = {
      kind: "break-requested" as const,
      source: "chat" as const,
      actor: "private-user",
      bugCount: 1 as const,
      severity: 1 as const,
    };
    engine.handlePublic(request);
    engine.handlePublic(request);
    expect(inspectMachine).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      type: "round.state",
      phase: "preparing",
    });
    expect(events[1]).toMatchObject({
      type: "overlay",
      event: { type: "machine.reset" },
    });
    expect(events[2]).toMatchObject({
      type: "round.machine",
      machine: sample(),
    });
    expect(events[3]).toMatchObject({
      type: "overlay",
      event: { type: "machine.load", machine: sample() },
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await engine.waitForRound();
    expect(result.phase).toBe("resolved");
    expect(result.machine).toEqual(sample());
    expect(repair).toHaveBeenCalledTimes(1);
    const broadcast = events.reduce(
      (state, event) =>
        event.type === "overlay" ? reduceBroadcast(state, event.event) : state,
      initialBroadcast(),
    );
    const client: ClientSnapshot = {
      frame: 600,
      hash: "12345678",
      alive: true,
      won: false,
      buildId: artifact("c").id,
      sdkSteps: 0,
      installs: [
        { buildId: artifact("b").id, frame: 0, statePreserved: true },
        { buildId: artifact("c").id, frame: 600, statePreserved: true },
      ],
      broadcast,
    };
    const receipt = publicReceipt({
      result,
      client,
      events: events.map((event, index) => ({
        event,
        sequence: index + 1,
        serverTimeMs: event.atMs ?? 1000,
      })),
      breaker: result.autopsy?.breaker ?? "viewer-0000000000000000",
    });
    expect(receipt.machine).toEqual(sample());
    expect(Object.keys(receipt.machine ?? {}).sort()).toEqual([
      "atMs",
      "busy",
      "coreCount",
      "load1m",
      "wallTime",
    ]);
    expect(receipt.events.some((event) => event.type === "round.machine")).toBe(
      true,
    );
    expect(JSON.stringify(receipt)).not.toContain("private-user");
    expect(
      engine.handlePrivate({
        kind: "sabotage-selected",
        actor: "private-user",
        family: "jump-buffer",
      }).accepted,
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect((await engine.waitForRound()).machine).toEqual(sample(2));
    expect(inspectMachine).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(2);
  });
});
