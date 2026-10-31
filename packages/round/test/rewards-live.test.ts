import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PublicIntent, TwitchEvent } from "../../twitch/src/events.js";
import { replayFixtures } from "../../twitch/src/fixtures.js";
import type {
  LiveRewards,
  RewardCapability,
} from "../../twitch/src/rewards.js";
import type {
  GameArtifact,
  PreparedGame,
  RoundEvent,
} from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { LiveRoundController } from "../src/live.js";

const fixture = (
  JSON.parse(
    readFileSync(
      new URL("../../twitch/fixtures/session.json", import.meta.url),
      "utf8",
    ),
  ) as TwitchEvent[]
)[2];
function redemption(
  id = "redeem-1",
  changes: Record<string, unknown> = {},
): TwitchEvent {
  if (fixture?.type !== "channel.channel_points_custom_reward_redemption.add")
    throw new Error("Missing reward fixture");
  return { type: fixture.type, event: { ...fixture.event, id, ...changes } };
}
const owned: RewardCapability = {
  path: "app-owned",
  rewardId: "fixture-reward",
  refundable: true,
};
function setup(
  options: { dashboard?: boolean; dryChat?: boolean; reject?: boolean } = {},
) {
  const logs: Record<string, unknown>[] = [];
  const api: LiveRewards = {
    setup: async () => owned,
    settle: vi.fn(async () => {}),
  };
  const capability: RewardCapability = options.dashboard
    ? {
        path: "dashboard-consume-only",
        rewardId: owned.rewardId,
        refundable: false,
      }
    : owned;
  const controller = new LiveRoundController({
    broadcasterId: "fixture-channel",
    botUserId: "fixture-channel",
    identify: (actor) => `hashed-${actor}`,
    record: (event) => logs.push(event),
    rewards: { api, capability },
    dryChat: options.dryChat ?? false,
    helix: {
      isLive: async () => false,
      chat: async () => "reply",
      marker: async () => {},
      clip: async () => {},
      pin: async () => {},
    },
  });
  let active = false;
  const state = (
    phase: "preparing" | "resolved" | "rolled-back",
  ): RoundEvent => ({
    type: "round.state",
    roundId: "round-1",
    phase,
    headStartEndsAt: null,
    winner: null,
    reason: null,
  });
  const engine = {
    snapshot: () => ({ active }),
    handlePublic: vi.fn((intent: PublicIntent) => {
      if (intent.kind === "break-requested" && !options.reject) {
        active = true;
        controller.observe(state("preparing"));
      }
    }),
    handlePrivate: vi.fn(),
  };
  controller.attach(engine);
  return {
    controller,
    engine,
    api,
    logs,
    breakInstalled() {
      controller.observe({
        type: "game.build",
        roundId: "round-1",
        buildId: "mutant",
        digest: "a",
        phase: "broken",
      });
    },
    finish(failed = false) {
      active = false;
      controller.observe(state(failed ? "rolled-back" : "resolved"));
    },
  };
}
describe("fixture-driven Channel Points rounds", () => {
  it("binds a redemption to the real engine round through preparation, installation and resolution", async () => {
    const test = setup();
    const artifact = (id: string): GameArtifact => ({
      id,
      digest: id,
      code: id,
    });
    // Runtime repair is an explicit test double. This checks the actual round
    // lifecycle and EventSub fixture wiring, without claiming a model or OS gate.
    const game: PreparedGame = {
      family: "jump-buffer",
      clean: artifact("clean"),
      broken: artifact("broken"),
      close: vi.fn(async () => {}),
      repair: vi.fn(async () => artifact("fixed")),
    };
    const engine = new RoundEngine({
      headStartMs: 0,
      identify: () => "viewer-1234567890abcdef",
      runtime: { prepare: async () => game },
      publish: (event) => test.controller.observe(event),
      activate: async (build, phase, roundId) => {
        test.controller.observe({
          type: "game.build",
          roundId,
          buildId: build.id,
          digest: build.digest,
          phase,
        });
      },
    });
    test.controller.attach(engine);
    try {
      replayFixtures([redemption()], test.controller.handler);
      const result = await engine.waitForRound();
      await test.controller.flush();
      expect(result.phase).toBe("resolved");
      expect(game.repair).toHaveBeenCalledOnce();
      expect(game.close).toHaveBeenCalledOnce();
      expect(test.api.settle).toHaveBeenCalledExactlyOnceWith(
        owned,
        "redeem-1",
        "FULFILLED",
      );
    } finally {
      await engine.stop();
      await test.controller.close();
    }
  });
  it.each([false, true])(
    "starts the same break intent and fulfills only after a round ends, Codex failed=%s",
    async (failed) => {
      const test = setup();
      replayFixtures([redemption()], test.controller.handler);
      expect(test.engine.handlePublic).toHaveBeenCalledExactlyOnceWith({
        kind: "break-requested",
        source: "reward",
        actor: "fixture-viewer",
        severity: 1,
        bugCount: 1,
      });
      expect(test.controller.displayName("hashed-fixture-viewer")).toBe(
        "Fixture Viewer",
      );
      expect(test.api.settle).not.toHaveBeenCalled();
      test.breakInstalled();
      await test.controller.flush();
      expect(test.api.settle).not.toHaveBeenCalled();
      test.finish(failed);
      await test.controller.flush();
      expect(test.api.settle).toHaveBeenCalledExactlyOnceWith(
        owned,
        "redeem-1",
        "FULFILLED",
      );
      // EventSub delivery and terminal-state redelivery cannot duplicate settlement.
      replayFixtures([redemption()], test.controller.handler);
      test.finish(failed);
      await test.controller.flush();
      expect(test.api.settle).toHaveBeenCalledTimes(1);
    },
  );
  it("refunds an owned reward when preparation fails before bug installation", async () => {
    const test = setup();
    replayFixtures([redemption()], test.controller.handler);
    test.finish(true);
    await test.controller.flush();
    expect(test.api.settle).toHaveBeenCalledExactlyOnceWith(
      owned,
      "redeem-1",
      "CANCELED",
    );
  });
  it("refunds only the rejected owned redemption during another round or cooldown", async () => {
    const test = setup();
    replayFixtures(
      [redemption(), redemption("concurrent")],
      test.controller.handler,
    );
    test.breakInstalled();
    test.finish();
    replayFixtures([redemption("cooldown")], test.controller.handler);
    await test.controller.flush();
    expect(test.engine.handlePublic).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(test.api.settle).mock.calls.map((call) => [call[1], call[2]]),
    ).toEqual([
      ["concurrent", "CANCELED"],
      ["redeem-1", "FULFILLED"],
      ["cooldown", "CANCELED"],
    ]);
  });
  it("refunds an owned start when the engine does not admit a round", async () => {
    const test = setup({ reject: true });
    replayFixtures([redemption()], test.controller.handler);
    await test.controller.flush();
    expect(test.api.settle).toHaveBeenCalledExactlyOnceWith(
      owned,
      "redeem-1",
      "CANCELED",
    );
  });
  it("consumes dashboard redemptions but logs manual settlement instead of forbidden fulfillment or refund", async () => {
    const test = setup({ dashboard: true });
    replayFixtures([redemption(), redemption("busy")], test.controller.handler);
    test.breakInstalled();
    test.finish();
    await test.controller.flush();
    expect(test.api.settle).not.toHaveBeenCalled();
    expect(
      test.logs
        .filter((event) => event.type === "twitch.reward-manual-settlement")
        .map((event) => event.requestedStatus),
    ).toEqual(["CANCELED", "FULFILLED"]);
  });
  it("does not call a pre-fulfilled redemption manually pending or send another update", async () => {
    const test = setup({ dashboard: true });
    replayFixtures(
      [redemption("redeem-1", { status: "fulfilled" })],
      test.controller.handler,
    );
    test.breakInstalled();
    test.finish();
    await test.controller.flush();
    expect(test.api.settle).not.toHaveBeenCalled();
    expect(test.logs).toContainEqual(
      expect.objectContaining({ type: "twitch.reward-already-fulfilled" }),
    );
    expect(
      test.logs.some(
        (event) => event.type === "twitch.reward-manual-settlement",
      ),
    ).toBe(false);
  });
  it("ignores a canceled redemption, another broadcaster or another reward", () => {
    const test = setup();
    replayFixtures(
      [
        redemption("cancel", { status: "canceled" }),
        redemption("other-channel", { broadcaster_user_id: "elsewhere" }),
        redemption("other-reward", {
          reward: {
            id: "different",
            title: "Break the game",
            cost: 100,
            prompt: "",
          },
        }),
      ],
      test.controller.handler,
    );
    expect(test.engine.handlePublic).not.toHaveBeenCalled();
    expect(test.api.settle).not.toHaveBeenCalled();
  });
  it("does not write any reward updates in dry chat", async () => {
    const test = setup({ dryChat: true });
    replayFixtures([redemption()], test.controller.handler);
    test.breakInstalled();
    test.finish();
    await test.controller.flush();
    expect(test.api.settle).not.toHaveBeenCalled();
    expect(test.logs).toContainEqual(
      expect.objectContaining({
        type: "twitch.reward-dry-run",
        requestedStatus: "FULFILLED",
      }),
    );
  });
  it("retains refused settlement evidence without failing a completed round", async () => {
    const test = setup();
    vi.mocked(test.api.settle).mockRejectedValue(new Error("refused"));
    replayFixtures([redemption()], test.controller.handler);
    test.breakInstalled();
    test.finish();
    await expect(test.controller.flush()).resolves.toBeUndefined();
    expect(test.logs).toContainEqual(
      expect.objectContaining({
        type: "twitch.refused",
        action: "redemption:redeem-1",
      }),
    );
  });
});
