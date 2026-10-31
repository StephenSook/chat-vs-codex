import { expect, it, vi } from "vitest";
import type { PreparedGame, RoundEvent } from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";

it("publishes the real classifier only after chat's entire head start and before the SDK starts", async () => {
  vi.useFakeTimers();
  const events: RoundEvent[] = [];
  const artifact = {
    id: "a".repeat(64),
    digest: "a".repeat(64),
    code: "fixture",
  };
  let started = false;
  const prepared: PreparedGame = {
    family: "gravity-sign",
    clean: artifact,
    broken: artifact,
    triage: {
      family: "platformer:jump-buffer",
      confidence: 0.61,
      modelDigest: "b".repeat(64),
    },
    repair: async () => {
      started = true;
      expect(
        events.some(
          (e) => e.type === "overlay" && e.event.type === "round.triage",
        ),
      ).toBe(true);
      return artifact;
    },
    close: async () => {},
  };
  const engine = new RoundEngine({
    now: () => Date.now(),
    runtime: { prepare: async () => prepared },
    publish: (e) => events.push(e),
    activate: async () => {},
    headStartMs: 15000,
  });
  try {
    engine.handlePublic({
      kind: "break-requested",
      source: "chat",
      actor: "viewer",
      bugCount: 1,
      severity: 1,
    });
    await vi.advanceTimersByTimeAsync(14999);
    expect(started).toBe(false);
    expect(
      events.some(
        (e) => e.type === "overlay" && e.event.type === "round.triage",
      ),
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    expect(
      events.filter(
        (e) => e.type === "overlay" && e.event.type === "round.triage",
      ),
    ).toHaveLength(1);
  } finally {
    await engine.stop();
    vi.useRealTimers();
  }
});
