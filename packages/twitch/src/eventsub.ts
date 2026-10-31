import { ApiClient } from "@twurple/api";
import type { RefreshingAuthProvider } from "@twurple/auth";
import { getRawData } from "@twurple/common";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import type { TwitchEvent, TwitchHandler } from "./events.js";

/** Queues all subscriptions before opening one broadcaster=bot user socket. */
export function createEventSub(options: {
  auth: RefreshingAuthProvider;
  broadcasterId: string;
  handler: TwitchHandler;
  record?: (event: TwitchEvent) => void;
  status?: (
    state: "connected" | "disconnected" | "subscription-failed",
  ) => void;
}): EventSubWsListener {
  const apiClient = new ApiClient({ authProvider: options.auth });
  const listener = new EventSubWsListener({
    apiClient,
    logger: { minLevel: "critical" },
  });
  const accept = (event: TwitchEvent) => {
    options.record?.(event);
    options.handler.handle(event);
  };
  const id = options.broadcasterId;
  listener.onChannelChatMessage(id, id, (event) =>
    accept({ type: "channel.chat.message", event: getRawData(event) }),
  );
  listener.onUserWhisperMessage(id, (event) =>
    accept({ type: "user.whisper.message", event: getRawData(event) }),
  );
  listener.onChannelRedemptionAdd(id, (event) =>
    accept({
      type: "channel.channel_points_custom_reward_redemption.add",
      event: getRawData(event),
    }),
  );
  listener.onChannelPowerUpRedemptionAdd(id, (event) =>
    accept({
      type: "channel.custom_power_up_redemption.add",
      event: getRawData(event),
    }),
  );
  listener.onChannelBitsUse(id, (event) =>
    accept({ type: "channel.bits.use", event: getRawData(event) }),
  );
  listener.onChannelRaidTo(id, (event) =>
    accept({ type: "channel.raid", event: getRawData(event) }),
  );
  listener.onChannelHypeTrainBeginV2(id, (event) =>
    accept({ type: "channel.hype_train.begin", event: getRawData(event) }),
  );
  listener.onChannelHypeTrainProgressV2(id, (event) =>
    accept({ type: "channel.hype_train.progress", event: getRawData(event) }),
  );
  listener.onChannelHypeTrainEndV2(id, (event) =>
    accept({ type: "channel.hype_train.end", event: getRawData(event) }),
  );
  listener.onUserSocketConnect(() => options.status?.("connected"));
  listener.onUserSocketDisconnect(() => options.status?.("disconnected"));
  listener.onSubscriptionCreateFailure(() =>
    options.status?.("subscription-failed"),
  );
  // Twurple EventSubBase deduplicates transport metadata.message_id before these
  // callbacks, including raid events whose external data has no event identifier.
  return listener;
}
