import { createHmac, randomBytes } from "node:crypto";
import {
  BUG_FAMILIES,
  type BugFamily,
  type Payloads,
  type TwitchEvent,
} from "../../twitch/src/events.js";
import { monotonicMs } from "./clocks.js";
import type { PreparedGame, RoundEvent, RoundRuntime } from "./contracts.js";
import { RoundEngine, type RoundSnapshot } from "./engine.js";
import { BOT_REPLY_PREFIXES } from "./live.js";

export type SharedSide = "left" | "right";
type Activate = ConstructorParameters<typeof RoundEngine>[0]["activate"];
export interface SharedChannel {
  broadcasterId: string;
  runtime: RoundRuntime;
  activate: Activate;
}
export interface SharedRouteReceipt {
  mode: "shared-chat-fixture";
  input: "chat";
  roundId: string;
  /** Salted labels, never Twitch identities or user content. */
  source: string;
  target: string;
  receivedIn: string;
  viewer: string;
  message: string;
  targetSide: SharedSide;
  atMs: number;
  wallTime: string;
  result: RoundSnapshot | null;
  failure: "round-task-failed" | null;
}
export interface SharedScoreboard {
  left: { chat: number; codex: number };
  right: { chat: number; codex: number };
  total: { chat: number; codex: number };
}

/** Fixture-only coordinator. A trusted EventSub adapter supplies subscriptionChannelId;
 * user text never supplies it. No live CLI enables this without a verified partner.
 * Each channel retains its own engine, runtime, activation client and round lifecycle.
 */
export class SharedChatVersus {
  private readonly channels: Record<SharedSide, SharedChannel>;
  private readonly engines: Record<SharedSide, RoundEngine>;
  private readonly key = randomBytes(32);
  private readonly seen = new Map<string, number>();
  private readonly cooldown = new Map<string, number>();
  private readonly sentIds = new Set<string>();
  private readonly routes: SharedRouteReceipt[] = [];
  private readonly tasks = new Set<Promise<void>>();
  private failure: { error: unknown } | null = null;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private stopped = false;

  constructor(
    private readonly options: {
      left: SharedChannel;
      right: SharedChannel;
      botUserIds?: readonly string[];
      now?: () => number;
      cooldownMs?: number;
      headStartMs?: number;
      roundLimitMs?: number;
      hardBudgetMs?: number;
      onRoundEvent?(side: SharedSide, event: RoundEvent): void;
    },
  ) {
    const { left, right } = options;
    if (
      !left.broadcasterId ||
      !right.broadcasterId ||
      left.broadcasterId === right.broadcasterId ||
      left.runtime === right.runtime ||
      left.activate === right.activate
    )
      throw new Error("Shared Chat requires two independent channel runners");
    this.channels = { left, right };
    this.now = options.now ?? monotonicMs;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0)
      throw new Error("Invalid Shared Chat cooldown");
    const prepared = new WeakSet<PreparedGame>();
    const build = (side: SharedSide) => {
      const channel = this.channels[side];
      return new RoundEngine({
        runtime: {
          prepare: async (...args) => {
            const game = await channel.runtime.prepare(...args);
            if (prepared.has(game))
              throw new Error(
                "Shared Chat runtimes reused mutable round state",
              );
            prepared.add(game);
            return game;
          },
        },
        activate: channel.activate,
        identify: (actor) => this.label("viewer", actor),
        publish: (event) => options.onRoundEvent?.(side, event),
        now: this.now,
        ...(options.headStartMs === undefined
          ? {}
          : { headStartMs: options.headStartMs }),
        ...(options.roundLimitMs === undefined
          ? {}
          : { roundLimitMs: options.roundLimitMs }),
        ...(options.hardBudgetMs === undefined
          ? {}
          : { hardBudgetMs: options.hardBudgetMs }),
      });
    };
    this.engines = { left: build("left"), right: build("right") };
  }

  private label(kind: "viewer" | "channel" | "message", value: string) {
    return `${kind}-${createHmac("sha256", this.key)
      .update(JSON.stringify([kind, value]))
      .digest("hex")
      .slice(0, 16)}`;
  }

  /** Returned Send Chat Message IDs supplement prefix and bot-account filtering. */
  rememberSentMessage(id: string): void {
    if (!id) return;
    this.sentIds.add(id);
    if (this.sentIds.size > 20_000) {
      const first = this.sentIds.values().next().value;
      if (first !== undefined) this.sentIds.delete(first);
    }
  }

  private route(
    subscriptionChannelId: string,
    event: Payloads["channel.chat.message"],
  ): { source: SharedSide; target: SharedSide; messageId: string } | null {
    if (event.broadcaster_user_id !== subscriptionChannelId) return null;
    const recipient = this.side(subscriptionChannelId);
    if (!recipient) return null;
    const sourceId = event.source_broadcaster_user_id;
    const hasSource = sourceId !== null && sourceId !== undefined;
    // A remote copy must carry both official source fields. Partial or unrelated
    // source metadata is refused rather than falling back to a different channel.
    if (
      hasSource &&
      (!sourceId ||
        sourceId === subscriptionChannelId ||
        !event.source_message_id)
    )
      return null;
    if (!hasSource && event.source_message_id) return null;
    const source = hasSource ? this.side(sourceId) : recipient;
    if (!source) return null;
    const messageId = hasSource ? event.source_message_id : event.message_id;
    if (!messageId || !event.message_id || !event.chatter_user_id) return null;
    return { source, target: source === "left" ? "right" : "left", messageId };
  }

  private side(id: string): SharedSide | null {
    if (id === this.channels.left.broadcasterId) return "left";
    if (id === this.channels.right.broadcasterId) return "right";
    return null;
  }

  /** Only authenticated chat payloads enter this boundary. Other event types
   * remain with their ordinary channel controller and cannot break both games.
   */
  handle(subscriptionChannelId: string, message: TwitchEvent): void {
    if (this.stopped || message.type !== "channel.chat.message") return;
    const event = message.event;
    const route = this.route(subscriptionChannelId, event);
    if (!route || event.channel_points_custom_reward_id) return;
    const actor = event.chatter_user_id;
    const text = event.message.text.trim();
    if (
      this.side(actor) ||
      this.options.botUserIds?.includes(actor) ||
      this.sentIds.has(event.message_id) ||
      this.sentIds.has(route.messageId) ||
      BOT_REPLY_PREFIXES.some((prefix) =>
        text.toLowerCase().startsWith(prefix.toLowerCase()),
      )
    )
      return;
    const guess = /^!guess\s+([a-z-]+)$/i.exec(text)?.[1]?.toLowerCase();
    const breaking = /^!break$/i.test(text);
    if (!breaking && !BUG_FAMILIES.includes(guess as BugFamily)) return;
    const now = this.now();
    for (const [key, at] of this.seen)
      if (at <= now - 86_400_000) this.seen.delete(key);
    for (const [key, until] of this.cooldown)
      if (until <= now) this.cooldown.delete(key);
    const key = JSON.stringify([route.source, route.messageId]);
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    if (this.seen.size > 20_000) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    const engine = this.engines[route.target];
    if (!breaking) {
      engine.handlePublic({
        kind: "guess-submitted",
        actor,
        word: guess ?? "",
      });
      return;
    }
    const before = engine.snapshot();
    if (before.active || (this.cooldown.get(actor) ?? -1) > now) return;
    if (this.cooldown.size >= 20_000) return;
    engine.handlePublic({
      kind: "break-requested",
      source: "chat",
      actor,
      bugCount: 1,
      severity: 1,
    });
    const admitted = engine.snapshot();
    const roundId = admitted.roundId;
    // Stopped engines retain their previous roundId. Only a newly admitted,
    // active round may consume cooldown or acquire a provenance receipt.
    if (!admitted.active || !roundId || roundId === before.roundId) return;
    this.cooldown.set(actor, now + this.cooldownMs);
    const receipt: SharedRouteReceipt = {
      mode: "shared-chat-fixture",
      input: "chat",
      roundId,
      source: this.label("channel", this.channels[route.source].broadcasterId),
      target: this.label("channel", this.channels[route.target].broadcasterId),
      receivedIn: this.label("channel", subscriptionChannelId),
      viewer: this.label("viewer", actor),
      message: this.label("message", route.messageId),
      targetSide: route.target,
      atMs: now,
      wallTime: new Date().toISOString(),
      result: null,
      failure: null,
    };
    this.routes.push(receipt);
    const task = engine.waitForRound().then(
      (result) => {
        receipt.result = result;
      },
      (error: unknown) => {
        receipt.failure = "round-task-failed";
        this.failure ??= { error };
      },
    );
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task));
  }

  scoreboard(): SharedScoreboard {
    const left = this.engines.left.snapshot().scores;
    const right = this.engines.right.snapshot().scores;
    return {
      left,
      right,
      total: { chat: left.chat + right.chat, codex: left.codex + right.codex },
    };
  }

  snapshot(side: SharedSide): RoundSnapshot {
    return structuredClone(this.engines[side].snapshot());
  }

  receipts(): SharedRouteReceipt[] {
    return structuredClone(this.routes);
  }

  async waitForRounds(): Promise<void> {
    await Promise.all([...this.tasks]);
    if (this.failure) throw this.failure.error;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const stopped = await Promise.allSettled([
      this.engines.left.stop(),
      this.engines.right.stop(),
    ]);
    await Promise.all([...this.tasks]);
    if (this.failure) throw this.failure.error;
    const rejected = stopped.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}
