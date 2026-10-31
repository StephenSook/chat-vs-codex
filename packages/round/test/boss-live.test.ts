import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TwitchEvent } from "../../twitch/src/events.js";
import { LiveRoundController } from "../src/live.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../twitch/fixtures/session.json", import.meta.url),
    "utf8",
  ),
) as TwitchEvent[];
function setup() {
  const engine = {
    snapshot: () => ({ active: false }),
    handlePublic: vi.fn(),
    handlePrivate: vi.fn(),
    requestBoss: vi.fn(),
    predictBoss: vi.fn(),
    armBoss: vi.fn(),
  };
  const controller = new LiveRoundController({
    broadcasterId: "fixture-channel",
    botUserId: "fixture-channel",
    identify: () => "viewer-0123456789abcdef",
    record: () => {},
    helix: {
      isLive: async () => false,
      chat: async () => "sent",
      marker: async () => {},
      clip: async () => {},
      pin: async () => {},
    },
  });
  controller.attach(engine);
  return { engine, controller };
}
function message(text: string, actor: string) {
  const base = fixtures.find((item) => item.type === "channel.chat.message");
  if (base?.type !== "channel.chat.message")
    throw new Error("Missing chat fixture");
  return {
    ...base,
    event: {
      ...base.event,
      chatter_user_id: actor,
      message_id: `${actor}-${text}`,
      message: { text, fragments: [] },
    },
  };
}
describe("boss fixture routing", () => {
  it("accepts the explicit broadcaster command but never lets a viewer start a boss", () => {
    const { engine, controller } = setup();
    controller.handler.handle(message("!boss", "viewer"));
    expect(engine.requestBoss).not.toHaveBeenCalled();
    controller.handler.handle(message("!boss", "fixture-channel"));
    expect(engine.requestBoss).toHaveBeenCalledWith("fixture-channel");
    controller.handler.handle(message("Codex fixed !boss", "fixture-channel"));
    expect(engine.requestBoss).toHaveBeenCalledOnce();
  });
  it("passes only model enum predictions and keeps them out of the repair hint channel", () => {
    const { engine, controller } = setup();
    controller.handler.handle(message("!boss sol", "viewer"));
    controller.handler.handle(message("!boss terra", "viewer"));
    controller.handler.handle(message("!boss secret source", "viewer"));
    expect(engine.predictBoss.mock.calls).toEqual([
      ["viewer", "sol"],
      ["viewer", "terra"],
    ]);
    expect(engine.handlePublic).not.toHaveBeenCalled();
    expect(engine.handlePrivate).not.toHaveBeenCalled();
  });
  it("arms the next round only when a real Hype Train level increases", () => {
    const { engine, controller } = setup();
    const base = fixtures.find(
      (item) => item.type === "channel.hype_train.progress",
    );
    if (base?.type !== "channel.hype_train.progress")
      throw new Error("Missing Hype Train fixture");
    for (const level of [1, 1, 2, 2])
      controller.handler.handle({ ...base, event: { ...base.event, level } });
    expect(engine.armBoss).toHaveBeenCalledOnce();
    controller.handler.handle({
      ...base,
      event: { ...base.event, level: 3, broadcaster_user_id: "other" },
    });
    expect(engine.armBoss).toHaveBeenCalledOnce();
  });
});
