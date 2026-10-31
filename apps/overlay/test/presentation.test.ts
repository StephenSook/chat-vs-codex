import {
  createState,
  HEIGHT,
  step,
  TILE,
  UNIT,
  WIDTH,
} from "@chat-vs-codex/sim";
import { describe, expect, it } from "vitest";
import { initialBroadcast, reduceBroadcast } from "../src/events.js";
import {
  actorPositions,
  cameraFor,
  corruptionFor,
  FOLLOW_ZOOM,
  VIEWPORT,
} from "../src/presentation.js";

describe("broadcast camera", () => {
  it("positions the visible enemy from the actual advancing simulation", () => {
    const start = createState(1);
    const next = step(start, 0);
    expect(actorPositions(start).enemy.x).toBe(800);
    expect(actorPositions(next).enemy.x).not.toBe(
      actorPositions(start).enemy.x,
    );
    const dropped = {
      ...next,
      enemy: { ...next.enemy, y: next.enemy.y + 50 * UNIT },
    };
    expect(actorPositions(dropped).enemy.y - actorPositions(next).enemy.y).toBe(
      50,
    );
  });
  it("follows the player with twice the original scale and a legible 720p sprite", () => {
    const start = createState(1);
    const camera = cameraFor(start.x, start.y, "follow");
    expect(camera.zoom).toBe(FOLLOW_ZOOM);
    expect((camera.player.height * 720) / 1080).toBeGreaterThanOrEqual(32);
    const middle = cameraFor(640 * UNIT, 200 * UNIT, "follow");
    expect(middle.left).toBeLessThan(camera.left);
    expect(middle.player.x + middle.player.width / 2).toBeCloseTo(
      VIEWPORT.width / 2,
    );
  });
  it("clamps at the world edges and retains a full-level overview", () => {
    const edge = cameraFor(1240 * UNIT, 300 * UNIT, "follow");
    expect(edge.player.x + edge.player.width).toBeLessThanOrEqual(
      VIEWPORT.width,
    );
    const overview = cameraFor(640 * UNIT, 200 * UNIT, "overview");
    expect(((WIDTH * TILE) / UNIT) * overview.zoom).toBeLessThanOrEqual(
      VIEWPORT.width,
    );
    expect(((HEIGHT * TILE) / UNIT) * overview.zoom).toBeLessThanOrEqual(
      VIEWPORT.height,
    );
    expect(overview.left).toBeGreaterThanOrEqual(0);
    expect(overview.top).toBeGreaterThanOrEqual(0);
  });
});

describe("observed corruption presentation", () => {
  const started = reduceBroadcast(initialBroadcast(), {
    type: "round.started",
    id: "r",
    number: 1,
    atMs: 0,
  });
  const active = reduceBroadcast(started, {
    type: "bug.active",
    roundId: "r",
    intensity: 0.7,
  });
  it("never activates from elapsed time and remains visible while a bug is active", () => {
    expect(corruptionFor(started, 999999, false).treatment).toBe("none");
    expect(corruptionFor(active, 0, false).rgbOffset).toBeCloseTo(6.3);
    expect(corruptionFor(active, 60000, false).intensity).toBe(0.7);
    expect(corruptionFor(active, 0, false).band).not.toBe(
      corruptionFor(active, 140, false).band,
    );
    expect(active.steps).toEqual([]);
    expect(active.chat + active.codex).toBe(0);
  });
  it("provides static on-game treatment for reduced motion and clears after real green", () => {
    expect(corruptionFor(active, 0, true)).toEqual(
      corruptionFor(active, 60000, true),
    );
    expect(corruptionFor(active, 0, true)).toMatchObject({
      intensity: 0.7,
      rgbOffset: 0,
      treatment: "static",
    });
    const green = reduceBroadcast(active, {
      type: "tests.green",
      roundId: "r",
    });
    expect(corruptionFor(green, 100, false).treatment).toBe("none");
  });
});
