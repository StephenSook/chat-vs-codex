import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Payloads,
  type PrivateIntent,
  type PublicIntent,
  TwitchHandler,
} from "../src/events.js";
import { anonymize, parseFixture, replayFixtures } from "../src/fixtures.js";
import { chooseReward } from "../src/rewards.js";

const fixtures = JSON.parse(
  readFileSync(new URL("../fixtures/session.json", import.meta.url), "utf8"),
) as unknown[];
function setup() {
  const publicEvents: PublicIntent[] = [];
  const privateEvents: PrivateIntent[] = [];
  const handler = new TwitchHandler({
    broadcasterId: "fixture-channel",
    breakRewardId: "fixture-reward",
    chaosPowerUpId: "fixture-chaos",
    sink: {
      public: (event) => publicEvents.push(event),
      private: (event) => privateEvents.push(event),
    },
  });
  return { handler, publicEvents, privateEvents };
}
function chat(
  text: string,
  id = "chat-1",
): { type: "channel.chat.message"; event: Payloads["channel.chat.message"] } {
  return {
    type: "channel.chat.message",
    event: {
      broadcaster_user_id: "fixture-channel",
      broadcaster_user_login: "fixture_channel",
      broadcaster_user_name: "Fixture Channel",
      chatter_user_id: "fixture-viewer",
      chatter_user_login: "fixture_viewer",
      chatter_user_name: "Fixture Viewer",
      message_id: id,
      message: { text, fragments: [{ type: "text", text }] },
      message_type: "text",
      badges: [],
      cheer: null,
      color: "",
      reply: null,
      channel_points_custom_reward_id: null,
      source_broadcaster_user_id: null,
      source_broadcaster_user_login: null,
      source_broadcaster_user_name: null,
      source_message_id: null,
      source_badges: null,
      is_source_only: null,
    },
  };
}

describe("Twitch inbound intents", () => {
  it("replays exact external fixture payloads without claiming rounds ran", () => {
    const { handler, publicEvents, privateEvents } = setup();
    replayFixtures(fixtures, handler);
    expect(
      publicEvents.filter((e) => e.kind === "break-requested"),
    ).toHaveLength(4);
    expect(publicEvents).toContainEqual({
      kind: "break-requested",
      source: "raid",
      actor: "fixture-raider",
      bugCount: 2,
      severity: 1,
    });
    expect(publicEvents.slice(-3)).toEqual([
      { kind: "severity-changed", severity: 3, active: true },
      { kind: "severity-changed", severity: 3, active: true },
      { kind: "severity-changed", severity: 1, active: false },
    ]);
    expect(privateEvents).toEqual([
      {
        kind: "sabotage-selected",
        actor: "fixture-viewer",
        family: "gravity-sign",
      },
    ]);
    expect(JSON.stringify(publicEvents)).not.toContain("gravity-sign");
  });
  it("only accepts bare break, one guess word and bare hint", () => {
    const { handler, publicEvents } = setup();
    [
      "!break gravity-sign",
      "!break",
      "!guess Gravity",
      "!guess too many words",
      "!hint",
      "!hint secret",
    ].forEach((text, n) => {
      handler.handle(chat(text, `chat-${n}`));
    });
    expect(publicEvents).toEqual([
      {
        kind: "break-requested",
        source: "chat",
        actor: "fixture-viewer",
        bugCount: 1,
        severity: 1,
      },
      { kind: "guess-submitted", actor: "fixture-viewer", word: "gravity" },
      { kind: "hint-requested", actor: "fixture-viewer" },
    ]);
  });
  it("deduplicates repeated message IDs and both Shared Chat delivery orders", () => {
    for (const sourceFirst of [true, false]) {
      const { handler, publicEvents } = setup();
      const source = chat("!break", "original");
      const copy = chat("!break", "copy");
      copy.event.source_message_id = "original";
      for (const event of sourceFirst
        ? [source, copy, source, copy]
        : [copy, source, copy, source])
        handler.handle(event);
      expect(publicEvents).toHaveLength(1);
    }
  });
  it("rejects cross-channel events and ignores reward chat copies", () => {
    const { handler, publicEvents } = setup();
    const other = chat("!break");
    other.event.broadcaster_user_id = "other";
    handler.handle(other);
    const reward = chat("!break", "reward-copy");
    reward.event.channel_points_custom_reward_id = "fixture-reward";
    handler.handle(reward);
    expect(publicEvents).toEqual([]);
  });
  it("handles custom power-ups once in either Bits delivery order without merging separate purchases", () => {
    const power = parseFixture(fixtures[3]);
    const bits = parseFixture(fixtures[4]);
    for (const order of [
      [power, bits],
      [bits, power],
    ]) {
      const { handler, publicEvents } = setup();
      for (const event of [...order, ...order]) handler.handle(event);
      expect(publicEvents).toHaveLength(1);
      if (power.type !== "channel.custom_power_up_redemption.add")
        throw new Error("Fixture type");
      handler.handle({
        ...power,
        event: {
          ...power.event,
          id: "power-2",
          user_input: "swapped-controls",
        },
      });
      expect(publicEvents).toHaveLength(2);
      expect(JSON.stringify(publicEvents)).not.toContain("swapped-controls");
    }
  });
  it("deduplicates whisper and reward identifiers", () => {
    const { handler, publicEvents, privateEvents } = setup();
    for (const index of [1, 1, 2, 2])
      handler.handle(parseFixture(fixtures[index]));
    expect(publicEvents).toHaveLength(1);
    expect(privateEvents).toHaveLength(1);
  });
  it("rejects malformed fixtures before replaying any of a batch", () => {
    const { handler, publicEvents } = setup();
    expect(() =>
      replayFixtures(
        [fixtures[0], { type: "channel.raid", event: {} }],
        handler,
      ),
    ).toThrow("identifiers");
    expect(publicEvents).toEqual([]);
    expect(() => parseFixture({ type: "toString", event: {} })).toThrow();
  });
});

describe("recording privacy and reward capabilities", () => {
  it("hashes stable identities and redacts secrets before persistence", () => {
    const whisper = parseFixture(fixtures[1]);
    const safe = anonymize(whisper, "test-salt-at-least-sixteen");
    const encoded = JSON.stringify(safe);
    expect(encoded).not.toContain("gravity-sign");
    expect(encoded).not.toContain("fixture-viewer");
    expect(encoded).not.toContain("Fixture Viewer");
    expect(anonymize(whisper, "test-salt-at-least-sixteen")).toEqual(safe);
    expect(anonymize(whisper, "different-salt-at-least-sixteen")).not.toEqual(
      safe,
    );
    expect(() => anonymize(whisper, "short")).toThrow();
  });
  it("uses documented 403 fallback and records consume-only refund capability", async () => {
    const paths: unknown[] = [];
    expect(
      await chooseReward({
        create: async () => {
          throw {
            statusCode: 403,
            body: '{"message":"The broadcaster is not a partner or affiliate."}',
          };
        },
        dashboardRewardId: "dashboard",
        log: (path) => paths.push(path),
      }),
    ).toEqual({
      path: "dashboard-consume-only",
      rewardId: "dashboard",
      refundable: false,
    });
    expect(paths).toHaveLength(1);
    expect(
      await chooseReward({
        create: async () => ({ id: "owned" }),
        log: (path) => paths.push(path),
      }),
    ).toEqual({ path: "app-owned", rewardId: "owned", refundable: true });
    await expect(
      chooseReward({
        create: async () => {
          throw { statusCode: 403, body: "missing scope" };
        },
        dashboardRewardId: "dashboard",
        log: (path) => paths.push(path),
      }),
    ).rejects.toThrow("has not selected");
    expect(paths).toHaveLength(2);
  });
});
