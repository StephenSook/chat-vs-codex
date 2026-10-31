import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PublicIntent, TwitchEvent } from "../../twitch/src/events.js";
import { replayFixtures } from "../../twitch/src/fixtures.js";
import type { LiveHelix } from "../../twitch/src/helix.js";
import type { RoundEvent } from "../src/contracts.js";
import { LiveRoundController } from "../src/live.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../twitch/fixtures/session.json", import.meta.url),
    "utf8",
  ),
) as TwitchEvent[];
function fixture<T extends TwitchEvent["type"]>(
  type: T,
): Extract<TwitchEvent, { type: T }> {
  const value = fixtures.find((event) => event.type === type);
  if (!value) throw new Error("Missing fixture");
  return structuredClone(value) as Extract<TwitchEvent, { type: T }>;
}
function setup() {
  const lines: string[] = [];
  const events: RoundEvent[] = [];
  const intents: PublicIntent[] = [];
  const helix: LiveHelix = {
    isLive: async () => false,
    chat: async (line) => {
      lines.push(line);
      return `reply-${lines.length}`;
    },
    marker: async () => {},
    clip: async () => {},
    pin: async () => {},
    powerUp: vi.fn(async (id) => ({
      id,
      broadcasterId: "fixture-channel",
      title: "Break the game",
    })),
  };
  let active = false;
  const controller = new LiveRoundController({
    broadcasterId: "fixture-channel",
    botUserId: "fixture-channel",
    helix,
    identify: () => "viewer-1234567890abcdef",
    record: () => {},
    publish: (event) => events.push(event),
  });
  controller.attach({
    snapshot: () => ({ active }),
    handlePublic: (intent) => {
      intents.push(intent);
      active = true;
    },
    handlePrivate: () => {},
  });
  return {
    controller,
    helix,
    lines,
    events,
    intents,
    idle: () => {
      active = false;
    },
  };
}
describe("raid and custom Power-up fixture entry points", () => {
  it("welcomes a raid once and arms the next chat break with its full normal head start", async () => {
    const { controller, lines, events, intents } = setup();
    const raid = fixture("channel.raid");
    replayFixtures([raid], controller.handler);
    await controller.flush();
    expect(intents).toEqual([]);
    expect(lines).toEqual([
      "Welcome raiders! Type !break to break the game, then !guess <family>. Chat gets 15 s.",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "overlay",
        event: { type: "twitch.raid", viewers: raid.event.viewers },
      }),
    ]);
    const chat = fixture("channel.chat.message");
    replayFixtures([chat], controller.handler);
    expect(intents).toEqual([
      {
        kind: "break-requested",
        source: "raid",
        actor: "fixture-viewer",
        bugCount: 1,
        severity: 1,
      },
    ]);
    await controller.close();
  });
  it("keeps the raid armed through an active round and ignores cross-channel raids", async () => {
    const { controller, intents, idle, events } = setup();
    replayFixtures(
      [fixture("channel.chat.message"), fixture("channel.raid")],
      controller.handler,
    );
    const denied = fixture("channel.chat.message");
    denied.event.message_id = "busy";
    denied.event.chatter_user_id = "raider-viewer";
    replayFixtures([denied], controller.handler);
    idle();
    denied.event.message_id = "after";
    replayFixtures([denied], controller.handler);
    expect(
      intents.map(
        (intent) => intent.kind === "break-requested" && intent.source,
      ),
    ).toEqual(["chat", "raid"]);
    const other = fixture("channel.raid");
    other.event.to_broadcaster_user_id = "other-channel";
    replayFixtures([other], controller.handler);
    expect(events).toHaveLength(1);
    await controller.close();
  });
  it("reads the actual custom Power-up, ignores free text and duplicate purchases, and starts only one round", async () => {
    const { controller, helix, intents } = setup();
    const power = fixture("channel.custom_power_up_redemption.add");
    power.event.user_input = "secret free chat must never reach Codex";
    replayFixtures([power, power], controller.handler);
    await controller.flush();
    expect(helix.powerUp).toHaveBeenCalledExactlyOnceWith("fixture-chaos");
    expect(intents).toEqual([
      {
        kind: "break-requested",
        source: "power-up",
        actor: "fixture-viewer",
        bugCount: 1,
        severity: 1,
      },
    ]);
    expect(JSON.stringify(intents)).not.toContain("secret");
    await controller.close();
  });
  it("refuses canceled, foreign or unreadable custom Power-ups without starting a round", async () => {
    const { controller, helix, intents } = setup();
    const canceled = fixture("channel.custom_power_up_redemption.add");
    canceled.event.status = "canceled";
    const other = fixture("channel.custom_power_up_redemption.add");
    other.event.broadcaster_user_id = "other";
    const unreadable = fixture("channel.custom_power_up_redemption.add");
    if (!helix.powerUp) throw new Error("Missing custom Power-up reader");
    vi.mocked(helix.powerUp).mockRejectedValue(new Error("Not found"));
    replayFixtures([canceled, other, unreadable], controller.handler);
    await controller.flush();
    expect(helix.powerUp).toHaveBeenCalledOnce();
    expect(intents).toEqual([]);
    await controller.close();
  });
});
