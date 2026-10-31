import type { DataObject } from "@twurple/common";
import type {
  EventSubChannelBitsUseEvent,
  EventSubChannelChatMessageEvent,
  EventSubChannelCustomPowerUpAddEvent,
  EventSubChannelHypeTrainBeginV2Event,
  EventSubChannelHypeTrainEndV2Event,
  EventSubChannelHypeTrainProgressV2Event,
  EventSubChannelRaidEvent,
  EventSubChannelRedemptionAddEvent,
  EventSubUserWhisperMessageEvent,
} from "@twurple/eventsub-base";

type Raw<T> = T extends DataObject<infer D> ? D : never;
export interface Payloads {
  "channel.chat.message": Raw<EventSubChannelChatMessageEvent>;
  "user.whisper.message": Raw<EventSubUserWhisperMessageEvent>;
  "channel.channel_points_custom_reward_redemption.add": Raw<EventSubChannelRedemptionAddEvent>;
  "channel.custom_power_up_redemption.add": Raw<EventSubChannelCustomPowerUpAddEvent>;
  "channel.bits.use": Raw<EventSubChannelBitsUseEvent>;
  "channel.raid": Raw<EventSubChannelRaidEvent>;
  "channel.hype_train.begin": Raw<EventSubChannelHypeTrainBeginV2Event>;
  "channel.hype_train.progress": Raw<EventSubChannelHypeTrainProgressV2Event>;
  "channel.hype_train.end": Raw<EventSubChannelHypeTrainEndV2Event>;
}

export type TwitchEvent = {
  [K in keyof Payloads]: { type: K; event: Payloads[K] };
}[keyof Payloads];

export const BUG_FAMILIES = [
  "gravity-sign",
  "collision-off-by-one",
  "swapped-controls",
  "coyote-never-expires",
  "jump-buffer",
  "enemy-ledge-turn",
] as const;
export type BugFamily = (typeof BUG_FAMILIES)[number];
export type Severity = 1 | 2 | 3;
export type PublicIntent =
  | {
      kind: "break-requested";
      source: "chat" | "reward" | "power-up" | "raid";
      actor: string;
      bugCount: 1 | 2;
      severity: Severity;
    }
  | { kind: "guess-submitted"; actor: string; word: string }
  | { kind: "hint-requested"; actor: string }
  | { kind: "severity-changed"; severity: Severity; active: boolean };
export type PrivateIntent = {
  kind: "sabotage-selected";
  actor: string;
  family: BugFamily;
};

export interface IntentSink {
  public(intent: PublicIntent): void;
  private(intent: PrivateIntent): void;
}

export interface HandlerOptions {
  broadcasterId: string;
  breakRewardId?: string;
  chaosPowerUpId?: string;
  sink: IntentSink;
  now?: () => number;
}

/** Bounded redelivery memory. Shared-chat source IDs are recorded alongside local IDs. */
export class TwitchHandler {
  private readonly seen = new Map<string, number>();
  private severity: Severity = 1;
  constructor(private readonly options: HandlerOptions) {}

  private duplicate(keys: string[]): boolean {
    const now = (this.options.now ?? Date.now)();
    for (const [key, at] of this.seen) {
      if (at < now - 24 * 60 * 60 * 1000) this.seen.delete(key);
    }
    const duplicate = keys.some((key) => this.seen.has(key));
    for (const key of keys) this.seen.set(key, now);
    while (this.seen.size > 20_000) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return duplicate;
  }

  handle(message: TwitchEvent): void {
    const { type, event } = message;
    const channel =
      "broadcaster_user_id" in event
        ? event.broadcaster_user_id
        : "to_broadcaster_user_id" in event
          ? event.to_broadcaster_user_id
          : event.to_user_id;
    if (channel !== this.options.broadcasterId) return;
    const emitBreak = (
      source: "chat" | "reward" | "power-up" | "raid",
      actor: string,
      bugCount: 1 | 2 = 1,
    ) => {
      this.options.sink.public({
        kind: "break-requested",
        source,
        actor,
        bugCount,
        severity: this.severity,
      });
    };
    switch (type) {
      case "channel.chat.message": {
        const data = message.event;
        const keys = [`chat:${data.message_id}`];
        if (data.source_message_id) keys.push(`chat:${data.source_message_id}`);
        if (this.duplicate(keys)) return;
        // Reward-input copies are handled only by the redemption subscription.
        if (data.channel_points_custom_reward_id) return;
        const text = data.message.text.trim();
        if (/^!break$/i.test(text)) emitBreak("chat", data.chatter_user_id);
        else if (/^!hint$/i.test(text))
          this.options.sink.public({
            kind: "hint-requested",
            actor: data.chatter_user_id,
          });
        else {
          const guess = /^!guess\s+([a-z0-9_-]{1,64})$/i.exec(text);
          if (guess?.[1])
            this.options.sink.public({
              kind: "guess-submitted",
              actor: data.chatter_user_id,
              word: guess[1].toLowerCase(),
            });
        }
        return;
      }
      case "user.whisper.message": {
        const data = message.event;
        if (this.duplicate([`whisper:${data.whisper_id}`])) return;
        const family = data.whisper.text.trim().toLowerCase();
        if (BUG_FAMILIES.includes(family as BugFamily))
          this.options.sink.private({
            kind: "sabotage-selected",
            actor: data.from_user_id,
            family: family as BugFamily,
          });
        return;
      }
      case "channel.channel_points_custom_reward_redemption.add": {
        const data = message.event;
        if (
          data.reward.id !== this.options.breakRewardId ||
          data.status === "canceled" ||
          this.duplicate([`reward:${data.id}`])
        )
          return;
        emitBreak("reward", data.user_id);
        return;
      }
      case "channel.custom_power_up_redemption.add": {
        const data = message.event;
        if (
          data.custom_power_up.id !== this.options.chaosPowerUpId ||
          data.status === "canceled" ||
          this.duplicate([`power:${data.id}`])
        )
          return;
        // Text is public on Twitch and is never treated as a secret selection.
        emitBreak("power-up", data.user_id);
        return;
      }
      case "channel.bits.use":
        // This payload has no redemption ID. The custom-power-up subscription is
        // authoritative; never guess a correlation from user, price or timing.
        return;
      case "channel.raid": {
        const data = message.event;
        // Twurple deduplicates transport IDs before this callback.
        emitBreak("raid", data.from_broadcaster_user_id, 2);
        return;
      }
      case "channel.hype_train.begin":
      case "channel.hype_train.progress":
      case "channel.hype_train.end": {
        const data = message.event;
        const active = type !== "channel.hype_train.end";
        this.severity = active
          ? data.level >= 5
            ? 3
            : data.level >= 2
              ? 2
              : 1
          : 1;
        this.options.sink.public({
          kind: "severity-changed",
          severity: this.severity,
          active,
        });
      }
    }
  }
}
