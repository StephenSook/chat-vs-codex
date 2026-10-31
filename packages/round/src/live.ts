import {
  BUG_FAMILIES,
  type PrivateIntent,
  type PublicIntent,
  type TwitchEvent,
  TwitchHandler,
} from "../../twitch/src/events.js";
import type { LiveHelix } from "../../twitch/src/helix.js";
import { TwitchRefusal } from "../../twitch/src/helix.js";
import type {
  LiveRewards,
  RewardCapability,
} from "../../twitch/src/rewards.js";
import { eventStamp, monotonicMs } from "./clocks.js";
import type { RoundAutopsy, RoundEvent } from "./contracts.js";

/** Covers early echoes that arrive before Send Chat Message returns its ID. */
export const BOT_REPLY_PREFIXES = [
  "Something broke.",
  "Correct guess:",
  "Codex fixed ",
  "Codex failed.",
  "Welcome raiders!",
  "Clip:",
  "Round busy.",
  "Still cooling down.",
  "Round unavailable.",
] as const;

export interface LiveEngine {
  snapshot(): { active: boolean };
  handlePublic(intent: PublicIntent): void;
  handlePrivate(intent: PrivateIntent): unknown;
}

/** One entry point for both live EventSub callbacks and the fixture replayer. */
export class LiveRoundController {
  readonly handler: TwitchHandler;
  private engine: LiveEngine | null = null;
  private currentActor: string | null = null;
  private readonly names = new Map<string, string>();
  private readonly cooldowns = new Map<string, number>();
  private readonly seenEffects = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly sentMessageIds = new Set<string>();
  private raidArmed = false;
  private raidSequence = 0;
  private outgoing = Promise.resolve();
  private stopped = false;
  private redemption: {
    id: string;
    fulfilled: boolean;
    roundId?: string;
  } | null = null;
  private readonly roundRedemptions = new Map<
    string,
    { id: string; fulfilled: boolean; ran: boolean }
  >();
  constructor(
    private readonly options: {
      broadcasterId: string;
      botUserId: string;
      helix: LiveHelix;
      identify(actor: string): string;
      record(event: Record<string, unknown>): void;
      publish?(event: RoundEvent): void;
      dryChat?: boolean;
      allowBroadcasterTest?: boolean;
      cooldownMs?: number;
      now?: () => number;
      rewards?: { api: LiveRewards; capability: RewardCapability };
    },
  ) {
    this.handler = new TwitchHandler({
      broadcasterId: options.broadcasterId,
      ...(options.rewards
        ? { breakRewardId: options.rewards.capability.rewardId }
        : {}),
      sink: {
        public: (intent) => this.publicIntent(intent),
        private: (intent) => this.privateIntent(intent),
      },
    });
    const accept = this.handler.handle.bind(this.handler);
    this.handler.handle = (message: TwitchEvent) => {
      if (this.stopped) return;
      if (message.type === "channel.chat.message") {
        const data = message.event;
        if (data.broadcaster_user_id !== options.broadcasterId) return;
        const text = data.message.text.trim();
        if (
          this.sentMessageIds.has(data.message_id) ||
          (data.source_message_id &&
            this.sentMessageIds.has(data.source_message_id)) ||
          BOT_REPLY_PREFIXES.some((prefix) =>
            text.toLowerCase().startsWith(prefix.toLowerCase()),
          )
        )
          return;
        const broadcasterTest =
          options.allowBroadcasterTest === true &&
          data.chatter_user_id === options.broadcasterId;
        if (
          (data.chatter_user_id === options.botUserId ||
            data.chatter_user_id === options.broadcasterId) &&
          !broadcasterTest
        )
          return;
        const guess = /^!guess\s+([a-z-]+)$/i.exec(text);
        if (
          guess &&
          !BUG_FAMILIES.includes(
            guess[1]?.toLowerCase() as (typeof BUG_FAMILIES)[number],
          )
        )
          return;
        if (!/^!break$/i.test(text) && !guess) return;
        this.remember(data.chatter_user_id, data.chatter_user_name);
      } else if (message.type === "user.whisper.message") {
        if (message.event.from_user_id === options.botUserId) return;
        if (message.event.to_user_id !== options.broadcasterId) return;
        this.remember(message.event.from_user_id, message.event.from_user_name);
      } else if (
        message.type === "channel.channel_points_custom_reward_redemption.add"
      ) {
        const data = message.event;
        if (
          data.broadcaster_user_id !== options.broadcasterId ||
          data.reward.id !== options.rewards?.capability.rewardId ||
          data.status === "canceled"
        )
          return;
        this.remember(data.user_id, data.user_name);
        this.redemption = {
          id: data.id,
          fulfilled: data.status === "fulfilled",
        };
        try {
          accept(message);
        } finally {
          this.redemption = null;
        }
        return;
      } else if (message.type === "channel.raid") {
        const data = message.event;
        if (
          data.to_broadcaster_user_id !== options.broadcasterId ||
          !Number.isSafeInteger(data.viewers) ||
          data.viewers < 0
        )
          return;
        this.raidArmed = true;
        const stamp = eventStamp();
        this.options.publish?.({
          ...stamp,
          type: "overlay",
          event: {
            type: "twitch.raid",
            viewers: data.viewers,
          },
        });
        this.log({ type: "twitch.raid-armed", viewers: data.viewers });
        this.schedule(`raid:${++this.raidSequence}:welcome`, async () => {
          await this.chat(
            "Welcome raiders! Type !break to break the game, then !guess <family>. Chat gets 15 s.",
          );
        });
        return;
      } else if (message.type === "channel.custom_power_up_redemption.add") {
        const data = message.event;
        if (
          data.broadcaster_user_id !== options.broadcasterId ||
          data.status === "canceled"
        )
          return;
        this.remember(data.user_id, data.user_name);
        this.schedule(`power-up:${data.id}`, async () => {
          if (!this.options.helix.powerUp)
            throw new Error("Custom Power-up lookup unavailable");
          const power = await this.options.helix.powerUp(
            data.custom_power_up.id,
          );
          if (
            power.id !== data.custom_power_up.id ||
            power.broadcasterId !== options.broadcasterId
          )
            throw new Error(
              "Custom Power-up lookup did not match the redemption",
            );
          if (this.stopped) return;
          this.log({ type: "twitch.power-up-read", powerUpId: power.id });
          this.publicIntent({
            kind: "break-requested",
            source: "power-up",
            actor: data.user_id,
            bugCount: 1,
            severity: 1,
          });
        });
        return;
      } else return;
      accept(message);
    };
  }
  attach(engine: LiveEngine): void {
    this.engine = engine;
  }
  private remember(actor: string, name: string): void {
    const safe = [...name]
      .filter(
        (letter) => letter.charCodeAt(0) >= 32 && letter.charCodeAt(0) !== 127,
      )
      .join("")
      .slice(0, 50);
    if (safe) this.names.set(this.options.identify(actor), safe);
    while (this.names.size > 20_000)
      this.names.delete(this.names.keys().next().value as string);
  }
  displayName(label: string | null): string | null {
    return label ? (this.names.get(label) ?? null) : null;
  }
  /** Presentation metadata is added only to outbound SSE; canonical evidence retains hashes. */
  present(event: RoundEvent): RoundEvent {
    if (event.type !== "overlay" || event.event.type !== "round.autopsy")
      return event;
    const card = event.event.autopsy;
    const presentation = {
      ...card,
      displayNames: {
        breaker: this.displayName(card.breaker),
        firstCorrectGuesser: this.displayName(card.firstCorrectGuesser),
      },
    };
    return {
      ...event,
      event: {
        ...event.event,
        autopsy: presentation,
      },
    };
  }
  private refusalReason(
    actor: string,
  ): "busy" | "cooldown" | "unavailable" | null {
    if (!this.engine) return "unavailable";
    if (this.engine.snapshot().active) return "busy";
    return (this.cooldowns.get(actor) ?? 0) >
      (this.options.now ?? monotonicMs)()
      ? "cooldown"
      : null;
  }
  private eligible(actor: string): boolean {
    if (this.refusalReason(actor)) return false;
    const now = (this.options.now ?? monotonicMs)();
    for (const [id, until] of this.cooldowns)
      if (until <= now) this.cooldowns.delete(id);
    if ((this.cooldowns.get(actor) ?? 0) > now) return false;
    this.cooldowns.set(actor, now + (this.options.cooldownMs ?? 60_000));
    return true;
  }
  private publicIntent(intent: PublicIntent): void {
    if (intent.kind === "break-requested" && !this.eligible(intent.actor)) {
      if (this.redemption)
        this.settleRedemption(
          this.redemption,
          false,
          this.refusalReason(intent.actor) ?? "unavailable",
        );
      return;
    }
    if (intent.kind !== "break-requested" && intent.kind !== "guess-submitted")
      return;
    if (
      intent.kind === "break-requested" &&
      intent.source === "chat" &&
      this.raidArmed
    ) {
      intent = { ...intent, source: "raid" };
      this.raidArmed = false;
    }
    this.currentActor = intent.actor;
    try {
      this.engine?.handlePublic(intent);
    } finally {
      this.currentActor = null;
      if (this.redemption && !this.redemption.roundId)
        this.settleRedemption(this.redemption, false);
    }
  }
  private settleRedemption(
    redemption: { id: string; fulfilled: boolean },
    ran: boolean,
    rejection?: "busy" | "cooldown" | "unavailable",
  ): void {
    const rewards = this.options.rewards;
    if (!rewards) return;
    this.schedule(`redemption:${redemption.id}`, async () => {
      if (redemption.fulfilled) {
        this.log({
          type: "twitch.reward-already-fulfilled",
          redemptionId: redemption.id,
        });
        return;
      }
      const status = ran ? "FULFILLED" : "CANCELED";
      if (this.options.dryChat || rewards.capability.path !== "app-owned") {
        this.log({
          type: this.options.dryChat
            ? "twitch.reward-dry-run"
            : "twitch.reward-manual-settlement",
          redemptionId: redemption.id,
          rewardId: rewards.capability.rewardId,
          requestedStatus: status,
          ...(rejection ? { rejection } : {}),
          reason: this.options.dryChat
            ? "All Twitch writes disabled."
            : "Only the creating app can update this dashboard reward. Broadcaster must settle it in the request queue.",
        });
        if (rejection) await this.refundReply(rejection, false);
        return;
      }
      await rewards.api.settle(rewards.capability, redemption.id, status);
      this.log({
        type: ran ? "twitch.reward-fulfilled" : "twitch.reward-refunded",
        redemptionId: redemption.id,
        rewardId: rewards.capability.rewardId,
        status,
        ...(rejection ? { reason: rejection } : {}),
      });
      if (rejection) await this.refundReply(rejection, true);
    });
  }
  private refundReply(
    reason: "busy" | "cooldown" | "unavailable",
    refunded: boolean,
  ): Promise<string | null> {
    const prefix = {
      busy: "Round busy.",
      cooldown: "Still cooling down.",
      unavailable: "Round unavailable.",
    }[reason];
    return this.chat(
      `${prefix} ${refunded ? "Your Channel Points were returned." : "Broadcaster: refund this reward in the request queue."}`,
    );
  }
  private privateIntent(intent: PrivateIntent): void {
    if (this.eligible(intent.actor)) this.engine?.handlePrivate(intent);
  }
  private log(event: Record<string, unknown>): void {
    this.options.record({ ...eventStamp(), ...event });
  }
  private schedule(key: string, operation: () => Promise<void>): void {
    if (this.stopped || this.seenEffects.has(key)) return;
    this.seenEffects.add(key);
    while (this.seenEffects.size > 20_000)
      this.seenEffects.delete(this.seenEffects.values().next().value as string);
    const task = operation()
      .catch((error: unknown) => {
        this.log({
          type: "twitch.refused",
          action: key,
          reason:
            error instanceof TwitchRefusal ? error.message : "request failed",
        });
      })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }
  private chat(line: string): Promise<string | null> {
    let id: string | null = null;
    const operation = this.outgoing.then(async () => {
      this.log({
        type: this.options.dryChat
          ? "twitch.dry-chat"
          : "twitch.chat-requested",
        line,
      });
      if (!this.options.dryChat) {
        id = await this.options.helix.chat(line);
        this.sentMessageIds.add(id);
      }
    });
    this.outgoing = operation.catch(() => {});
    return operation.then(() => id);
  }
  private async liveOnly(
    action: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.options.dryChat) {
      this.log({ type: "twitch.skipped", action, reason: "dry-chat" });
      return;
    }
    if (!(await this.options.helix.isLive())) {
      this.log({ type: "twitch.skipped", action, reason: "offline" });
      return;
    }
    await operation();
    this.log({ type: "twitch.accepted", action });
  }
  /** Called synchronously from engine.publish, before an actor command returns. */
  observe(event: RoundEvent): void {
    const id =
      event.type === "overlay"
        ? "roundId" in event.event
          ? event.event.roundId
          : null
        : event.roundId;
    if (!id) return;
    if (
      event.type === "round.state" &&
      event.phase === "preparing" &&
      this.redemption
    ) {
      this.redemption.roundId = id;
      this.roundRedemptions.set(id, { ...this.redemption, ran: false });
    }
    if (event.type === "game.build" && event.phase === "broken") {
      const redemption = this.roundRedemptions.get(id);
      if (redemption) redemption.ran = true;
    }
    if (
      event.type === "round.state" &&
      (event.phase === "resolved" || event.phase === "rolled-back")
    ) {
      const redemption = this.roundRedemptions.get(id);
      if (redemption) {
        this.roundRedemptions.delete(id);
        this.settleRedemption(redemption, redemption.ran);
      }
    }
    if (event.type === "game.build" && event.phase === "broken") {
      this.schedule(`${id}:start`, async () => {
        await this.chat("Something broke. Chat has 15 s.");
      });
      this.schedule(`${id}:bug-in`, () =>
        this.liveOnly("bug-in marker", () =>
          this.options.helix.marker("Chat vs Codex: bug-in"),
        ),
      );
    }
    if (event.type === "game.build" && event.phase === "repaired") {
      this.schedule(`${id}:fix-landed`, () =>
        this.liveOnly("fix-landed marker", () =>
          this.options.helix.marker("Chat vs Codex: fix-landed"),
        ),
      );
    }
    if (
      event.type === "overlay" &&
      event.event.type === "bug.named" &&
      this.currentActor
    ) {
      const name =
        this.displayName(this.options.identify(this.currentActor)) ??
        "A viewer";
      const family = event.event.name;
      this.schedule(`${id}:correct`, async () => {
        await this.chat(
          `Correct guess: ${name} named it: ${family}. Chat wins!`,
        );
      });
    }
    if (event.type === "overlay" && event.event.type === "round.autopsy") {
      this.autopsy(event.event.autopsy);
    }
  }
  private autopsy(card: RoundAutopsy): void {
    const green =
      card.status === "verified" && card.durations.timeToGreenMs !== null;
    if (!green) {
      this.schedule(`${card.roundId}:failed`, async () => {
        await this.chat(
          card.reason === "rollback-failed" ||
            card.reason === "rollback-timeout"
            ? "Codex failed. Restore needs attention."
            : "Codex failed. The game was rolled back.",
        );
      });
      return;
    }
    const total = Math.round((card.durations.timeToGreenMs as number) / 10);
    const split = `${Math.floor(total / 6000)}:${String(Math.floor(total / 100) % 60).padStart(2, "0")}.${String(total % 100).padStart(2, "0")}`;
    const line = `Codex fixed ${card.family}. GREEN ${split}${card.regressionTest ? " | +1 test" : ""}`;
    this.schedule(`${card.roundId}:clip`, () =>
      this.liveOnly("fix-landed clip", async () => {
        const title = `Codex fixed ${card.family} in ${((card.durations.timeToGreenMs as number) / 1000).toFixed(1)} s`;
        const clip = await this.options.helix.clip(title);
        if (!clip) return;
        this.log({
          type: "twitch.clip-requested",
          roundId: card.roundId,
          title,
          clipId: clip.id,
          url: clip.url,
          titlePath: clip.titlePath,
          ...(clip.titleRefusal ? { titleRefusal: clip.titleRefusal } : {}),
        });
        await this.chat(`Clip: ${clip.url}`);
      }),
    );
    this.schedule(`${card.roundId}:fixed`, async () => {
      const messageId = await this.chat(line);
      if (messageId)
        await this.liveOnly("autopsy pin", () =>
          this.options.helix.pin(messageId),
        );
    });
  }
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }
}
