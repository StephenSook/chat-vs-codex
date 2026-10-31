import {
  BUG_FAMILIES,
  type PrivateIntent,
  type PublicIntent,
  type TwitchEvent,
  TwitchHandler,
} from "../../twitch/src/events.js";
import type { LiveHelix } from "../../twitch/src/helix.js";
import { TwitchRefusal } from "../../twitch/src/helix.js";
import { eventStamp, monotonicMs } from "./clocks.js";
import type { RoundAutopsy, RoundEvent } from "./contracts.js";

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
  private outgoing = Promise.resolve();
  private stopped = false;
  constructor(
    private readonly options: {
      broadcasterId: string;
      botUserId: string;
      helix: LiveHelix;
      identify(actor: string): string;
      record(event: Record<string, unknown>): void;
      dryChat?: boolean;
      cooldownMs?: number;
      now?: () => number;
    },
  ) {
    this.handler = new TwitchHandler({
      broadcasterId: options.broadcasterId,
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
        if (data.chatter_user_id === options.botUserId) return;
        if (data.broadcaster_user_id !== options.broadcasterId) return;
        const text = data.message.text.trim();
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
      } else return; // Monetization and raids are intentionally not enabled by this mode.
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
  private eligible(actor: string): boolean {
    if (!this.engine || this.engine.snapshot().active) return false;
    const now = (this.options.now ?? monotonicMs)();
    for (const [id, until] of this.cooldowns)
      if (until <= now) this.cooldowns.delete(id);
    if ((this.cooldowns.get(actor) ?? 0) > now) return false;
    this.cooldowns.set(actor, now + (this.options.cooldownMs ?? 60_000));
    return true;
  }
  private publicIntent(intent: PublicIntent): void {
    if (intent.kind === "break-requested" && !this.eligible(intent.actor))
      return;
    if (intent.kind !== "break-requested" && intent.kind !== "guess-submitted")
      return;
    this.currentActor = intent.actor;
    try {
      this.engine?.handlePublic(intent);
    } finally {
      this.currentActor = null;
    }
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
      if (!this.options.dryChat) id = await this.options.helix.chat(line);
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
      this.schedule(`${id}:clip`, () =>
        this.liveOnly("fix-landed clip", () => this.options.helix.clip()),
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
        await this.chat(`${name} named it: ${family}. Chat wins!`);
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
