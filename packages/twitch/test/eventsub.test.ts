import { readFileSync } from "node:fs";
import { RefreshingAuthProvider } from "@twurple/auth";
import { getRawData } from "@twurple/common";
import { EventSubChannelChatMessageEvent } from "@twurple/eventsub-base";
import { describe, expect, it, vi } from "vitest";
import {
  type Payloads,
  type PublicIntent,
  TwitchHandler,
} from "../src/events.js";
import { createEventSub } from "../src/eventsub.js";

const { calls } = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown[] }[],
}));
vi.mock("@twurple/eventsub-ws", () => ({
  EventSubWsListener: class {
    constructor(options: unknown) {
      calls.push({ name: "constructor", args: [options] });
    }
    onChannelChatMessage(...args: unknown[]) {
      calls.push({ name: "chat", args });
    }
    onUserWhisperMessage(...args: unknown[]) {
      calls.push({ name: "whisper", args });
    }
    onChannelRedemptionAdd(...args: unknown[]) {
      calls.push({ name: "reward", args });
    }
    onChannelPowerUpRedemptionAdd(...args: unknown[]) {
      calls.push({ name: "power", args });
    }
    onChannelBitsUse(...args: unknown[]) {
      calls.push({ name: "bits", args });
    }
    onChannelRaidTo(...args: unknown[]) {
      calls.push({ name: "raid", args });
    }
    onChannelHypeTrainBeginV2(...args: unknown[]) {
      calls.push({ name: "hype-begin-v2", args });
    }
    onChannelHypeTrainProgressV2(...args: unknown[]) {
      calls.push({ name: "hype-progress-v2", args });
    }
    onChannelHypeTrainEndV2(...args: unknown[]) {
      calls.push({ name: "hype-end-v2", args });
    }
    onUserSocketConnect() {}
    onUserSocketDisconnect() {}
    onSubscriptionCreateFailure() {}
  },
}));

describe("Twurple live entry point", () => {
  it("uses one listener and the same broadcaster and bot user, forwarding real DataObject data", () => {
    calls.length = 0;
    const auth = new RefreshingAuthProvider({ clientId: "testclient" });
    const output: PublicIntent[] = [];
    const handler = new TwitchHandler({
      broadcasterId: "fixture-channel",
      sink: { public: (intent) => output.push(intent), private: () => {} },
    });
    const recorder = vi.fn();
    createEventSub({
      auth,
      broadcasterId: "fixture-channel",
      handler,
      record: recorder,
    });
    expect(calls.filter((call) => call.name === "constructor")).toHaveLength(1);
    expect(
      calls
        .filter((call) => call.name !== "constructor")
        .map((call) => call.args[0]),
    ).toEqual(Array(9).fill("fixture-channel"));
    const chat = calls.find((call) => call.name === "chat");
    expect(chat?.args[1]).toBe("fixture-channel");
    const data = (
      JSON.parse(
        readFileSync(
          new URL("../fixtures/session.json", import.meta.url),
          "utf8",
        ),
      ) as { event: Payloads["channel.chat.message"] }[]
    )[0]?.event;
    if (!data) throw new Error("Missing fixture");
    const real = new EventSubChannelChatMessageEvent(data);
    const callback = chat?.args[2] as (
      event: EventSubChannelChatMessageEvent,
    ) => void;
    callback(real);
    expect(recorder).toHaveBeenCalledWith({
      type: "channel.chat.message",
      event: getRawData(real),
    });
    expect(output).toEqual([
      {
        kind: "break-requested",
        source: "chat",
        actor: "fixture-viewer",
        bugCount: 1,
        severity: 1,
      },
    ]);
  });
});
