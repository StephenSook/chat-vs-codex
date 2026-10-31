import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { OverlayEvent } from "../../../apps/overlay/src/events.js";
import {
  BUG_FAMILIES,
  type BugFamily,
  type PrivateIntent,
  type PublicIntent,
} from "../../twitch/src/events.js";
import { eventStamp, monotonicMs } from "./clocks.js";
import type {
  GameArtifact,
  PreparedGame,
  PreviousVerifiedRound,
  RegressionTest,
  RoundAutopsy,
  RoundDurations,
  RoundEvent,
  RoundRuntime,
  RuntimeObservation,
  RuntimeTimings,
} from "./contracts.js";
import { sdkOverlayEvent } from "./sdk-events.js";

const CLEANUP_BUDGET_MS = 5_000;

type PublicState = Extract<RoundEvent, { type: "round.state" }>;
export interface RoundSnapshot extends PublicState {
  scores: { chat: number; codex: number };
  guessClosesAt: number | null;
  active: boolean;
  autopsy?: RoundAutopsy | null;
}
interface ActiveRound {
  id: string;
  selectedFamily?: BugFamily;
  abort: AbortController;
  prepared: PreparedGame | null;
  votes: Map<string, BugFamily>;
  startedAt: number | null;
  winner: "chat" | "codex" | null;
  reason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  visible: boolean;
  headStartFinishedAt: number | null;
  timings: Partial<RuntimeTimings>;
  swapStartedAt: number | null;
  swapFinishedAt: number | null;
  patchSequence: number;
  breaker: string | null;
  firstCorrectGuesser: string | null;
  correctGuessRecorded: boolean;
  completed: boolean;
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const aborted = () => {
      abandoned = true;
      reject(signal.reason);
    };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        if (abandoned) late?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        if (!abandoned) reject(error);
      },
    );
  });
}

export class RoundEngine {
  private current: ActiveRound | null = null;
  private task: Promise<RoundSnapshot> | null = null;
  private activation = Promise.resolve();
  private stopped = false;
  private number = 0;
  private scores = { chat: 0, codex: 0 };
  private state: PublicState = {
    type: "round.state",
    roundId: null,
    phase: "idle",
    headStartEndsAt: null,
    winner: null,
    reason: null,
  };
  private guessClosesAt: number | null = null;
  private readonly now: () => number;
  private readonly headStartMs: number;
  private readonly roundLimitMs: number;
  private readonly hardBudgetMs: number;
  private readonly identityKey = randomBytes(32);
  private previous: PreviousVerifiedRound | null;
  private autopsy: RoundAutopsy | null = null;

  constructor(
    private readonly options: {
      runtime: RoundRuntime;
      publish(event: RoundEvent): void;
      activate(
        artifact: GameArtifact,
        phase: "broken" | "repaired" | "rollback",
        roundId: string,
        signal: AbortSignal,
      ): Promise<void>;
      now?: () => number;
      headStartMs?: number;
      roundLimitMs?: number;
      hardBudgetMs?: number;
      identify?: (actor: string) => string | null;
      /** An explicitly opted-in session must never produce viewer-round evidence. */
      trigger?: "broadcaster-test";
      previousRound?: PreviousVerifiedRound | null;
    },
  ) {
    this.now = options.now ?? monotonicMs;
    this.headStartMs = options.headStartMs ?? 15_000;
    this.roundLimitMs = options.roundLimitMs ?? 60_000;
    this.hardBudgetMs = options.hardBudgetMs ?? 240_000;
    this.previous = options.previousRound ?? null;
    if (
      ![this.headStartMs, this.roundLimitMs, this.hardBudgetMs].every(
        Number.isFinite,
      ) ||
      this.headStartMs < 0 ||
      this.roundLimitMs <= this.headStartMs ||
      this.hardBudgetMs < this.roundLimitMs
    )
      throw new Error("Invalid round timing configuration");
  }

  snapshot(): RoundSnapshot {
    return {
      ...this.state,
      scores: { ...this.scores },
      guessClosesAt: this.guessClosesAt,
      active: this.current !== null,
      autopsy: this.autopsy,
    };
  }
  waitForRound(): Promise<RoundSnapshot> {
    return this.task ?? Promise.resolve(this.snapshot());
  }

  handlePublic(intent: PublicIntent): void {
    if (this.stopped) return;
    if (intent.kind === "break-requested") {
      if (this.current) return;
      if (intent.bugCount !== 1) {
        this.publish({
          ...this.state,
          reason: "unsupported-bug-count",
        });
        return;
      }
      this.startRound(intent.actor);
      return;
    }
    const round = this.current;
    if (
      intent.kind !== "guess-submitted" ||
      !round ||
      round.abort.signal.aborted ||
      !round.prepared ||
      round.startedAt === null ||
      round.swapFinishedAt !== null ||
      this.now() >= round.startedAt + this.roundLimitMs
    )
      return;
    if (!BUG_FAMILIES.includes(intent.word as BugFamily)) return;
    const family = intent.word as BugFamily;
    if (family === round.prepared.family && !round.correctGuessRecorded) {
      round.correctGuessRecorded = true;
      round.firstCorrectGuesser = this.identify(intent.actor);
    }
    if (this.now() < round.startedAt + this.headStartMs)
      round.votes.set(intent.actor, family);
    if (family === round.prepared.family && round.winner === null) {
      round.winner = "chat";
      this.scores.chat++;
      this.overlay({ type: "bug.named", roundId: round.id, name: family });
      this.overlay({ type: "score.changed", ...this.scores });
      this.phase(round, this.state.phase);
    }
  }

  private startRound(actor: string, selectedFamily?: BugFamily): void {
    const round: ActiveRound = {
      id: randomUUID(),
      ...(selectedFamily ? { selectedFamily } : {}),
      abort: new AbortController(),
      prepared: null,
      votes: new Map(),
      startedAt: null,
      winner: null,
      reason: null,
      timer: null,
      visible: false,
      headStartFinishedAt: null,
      timings: {},
      swapStartedAt: null,
      swapFinishedAt: null,
      patchSequence: 0,
      breaker: this.identify(actor),
      firstCorrectGuesser: null,
      correctGuessRecorded: false,
      completed: false,
    };
    this.current = round;
    this.autopsy = null;
    this.guessClosesAt = null;
    this.phase(round, "preparing");
    this.task = this.run(round);
  }

  /** Only an enum reaches selection; it is never published or included in the ticket. */
  handlePrivate(intent: PrivateIntent): { accepted: boolean; reason?: string } {
    if (this.stopped) return { accepted: false, reason: "stopped" };
    if (this.current) return { accepted: false, reason: "round-active" };
    if (!BUG_FAMILIES.includes(intent.family))
      return { accepted: false, reason: "invalid-family" };
    this.startRound(intent.actor, intent.family);
    return { accepted: true };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const round = this.current;
    if (round && !round.completed) {
      round.reason = "stopped";
      round.abort.abort(new Error("stopped"));
    }
    await this.task;
  }

  private overlay(event: OverlayEvent): void {
    this.publish({ type: "overlay", event });
  }
  private identify(actor: string): string | null {
    try {
      const label = this.options.identify
        ? this.options.identify(actor)
        : `viewer-${createHmac("sha256", this.identityKey).update(actor).digest("hex").slice(0, 16)}`;
      return typeof label === "string" && /^viewer-[a-f0-9]{16}$/.test(label)
        ? label
        : null;
    } catch {
      return null;
    }
  }
  private finishAutopsy(
    round: ActiveRound,
    artifact: GameArtifact | null,
    regressionTest: RegressionTest | null,
    regressionError: string | null,
  ): void {
    const verified = this.state.phase === "resolved";
    const durations = this.durations(round);
    if (!verified) durations.timeToGreenMs = null;
    const current = durations.timeToGreenMs;
    const prior = this.previous?.timeToGreenMs ?? null;
    const explanation = artifact?.diagnosis?.explanation
      .replace(/\s+/g, " ")
      .trim();
    this.autopsy = {
      roundId: round.id,
      ...(this.options.trigger ? { trigger: this.options.trigger } : {}),
      status: verified ? "verified" : "rolled-back",
      reason: round.reason,
      breaker: round.breaker,
      firstCorrectGuesser: round.firstCorrectGuesser,
      family: round.prepared?.family ?? null,
      winner: round.winner,
      patch: verified ? (artifact?.patch ?? null) : null,
      explanation: verified && explanation ? explanation : null,
      headline: verified ? (artifact?.diagnosis?.headline ?? null) : null,
      durations,
      previousRoundId: this.previous?.roundId ?? null,
      deltaMs:
        verified && current !== null && prior !== null ? current - prior : null,
      regressionTest,
      regressionError,
    };
    this.overlay({
      type: "round.autopsy",
      roundId: round.id,
      autopsy: this.autopsy,
    });
    if (verified) this.previous = { roundId: round.id, timeToGreenMs: current };
  }
  private async recordRegression(round: ActiveRound): Promise<{
    test: RegressionTest | null;
    error: string | null;
  }> {
    if (
      !round.prepared?.recordRegression ||
      round.breaker === null ||
      !/^viewer-[a-f0-9]{16}$/.test(round.breaker)
    )
      return { test: null, error: null };
    const record = round.prepared.recordRegression.bind(round.prepared);
    const credit = Object.freeze({ roundId: round.id, viewer: round.breaker });
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("regression-timeout")),
      CLEANUP_BUDGET_MS,
    );
    try {
      const recorded = await abortable(
        Promise.resolve().then(() => record(credit)),
        deadline.signal,
      );
      if (
        !recorded ||
        recorded.path !== `chat-found/${round.id}.json` ||
        typeof recorded.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(recorded.digest)
      )
        throw new Error("Invalid regression metadata");
      return {
        test: Object.freeze({ path: recorded.path, digest: recorded.digest }),
        error: null,
      };
    } catch {
      return {
        test: null,
        error: deadline.signal.aborted
          ? "regression-timeout"
          : "regression-write-failed",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  private stamp() {
    return { ...eventStamp(), atMs: this.now() };
  }
  private publish(event: RoundEvent): void {
    this.options.publish({
      ...event,
      ...(this.options.trigger ? { trigger: this.options.trigger } : {}),
      ...this.stamp(),
    });
  }
  private durations(round: ActiveRound): RoundDurations {
    const elapsed = (
      start: number | null | undefined,
      end: number | null | undefined,
    ) => (start == null || end == null || end < start ? null : end - start);
    return {
      headStartMs: elapsed(round.startedAt, round.headStartFinishedAt),
      repairMs: elapsed(
        round.timings.threadStartedAtMs,
        round.timings.patchReadyAtMs,
      ),
      validationMs: elapsed(
        round.timings.validationStartedAtMs,
        round.timings.validationFinishedAtMs,
      ),
      swapMs: elapsed(round.swapStartedAt, round.swapFinishedAt),
      timeToGreenMs: elapsed(
        round.timings.threadStartedAtMs,
        round.swapFinishedAt,
      ),
    };
  }
  private observe(round: ActiveRound, observation: RuntimeObservation): void {
    if (
      this.current !== round ||
      round.abort.signal.aborted ||
      !["repairing", "validating"].includes(this.state.phase) ||
      !Number.isFinite(observation.atMs)
    )
      return;
    if (observation.type === "runtime.replay") {
      if (this.state.phase === "validating")
        this.overlay({
          type: "round.ghost",
          roundId: round.id,
          replay: observation.replay,
        });
      return;
    }
    if (observation.type === "runtime.patch") {
      if (
        !Number.isInteger(observation.patch.added) ||
        !Number.isInteger(observation.patch.removed) ||
        observation.patch.added < 0 ||
        observation.patch.removed < 0
      )
        return;
      this.overlay({
        type: "codex.step",
        roundId: round.id,
        id: `patch-${++round.patchSequence}`,
        startedAtMs: this.now(),
        attempt: 1,
        total: 1,
        step: {
          kind: "patch",
          added: observation.patch.added,
          removed: observation.patch.removed,
        },
        status: "done",
      });
      return;
    }
    const keys = {
      "thread-started": "threadStartedAtMs",
      "patch-ready": "patchReadyAtMs",
      "validation-started": "validationStartedAtMs",
      "validation-passed": "validationFinishedAtMs",
    } as const;
    const key = keys[observation.phase];
    if (key === undefined) return;
    const ordered = Object.values(keys);
    const index = ordered.indexOf(key);
    const previous = ordered[index - 1];
    const prior = previous === undefined ? undefined : round.timings[previous];
    if (
      round.timings[key] !== undefined ||
      (index > 0 && prior === undefined) ||
      (prior !== undefined && observation.atMs < prior)
    )
      return;
    round.timings[key] = observation.atMs;
    this.phase(
      round,
      observation.phase === "validation-started"
        ? "validating"
        : this.state.phase,
    );
  }
  private phase(round: ActiveRound, phase: PublicState["phase"]): void {
    const durations = this.durations(round);
    if (phase === "rolled-back") durations.timeToGreenMs = null;
    this.state = {
      type: "round.state",
      roundId: round.id,
      ...(this.options.trigger ? { trigger: this.options.trigger } : {}),
      phase,
      headStartEndsAt:
        round.startedAt === null ? null : round.startedAt + this.headStartMs,
      winner: round.winner,
      reason: round.reason,
      durations,
      ...this.stamp(),
    };
    this.options.publish({ ...this.state });
  }
  private arm(round: ActiveRound, milliseconds: number, reason: string): void {
    if (round.timer) clearTimeout(round.timer);
    round.timer = setTimeout(() => {
      round.reason = reason;
      round.abort.abort(new Error(reason));
    }, milliseconds);
  }
  private async activate(
    round: ActiveRound,
    artifact: GameArtifact,
    phase: "broken" | "repaired" | "rollback",
  ): Promise<void> {
    const rollback = phase === "rollback" ? new AbortController() : null;
    const signal = rollback?.signal ?? round.abort.signal;
    const timer = rollback
      ? setTimeout(
          () => rollback.abort(new Error("rollback-timeout")),
          CLEANUP_BUDGET_MS,
        )
      : null;
    const task = this.activation.then(async () => {
      signal.throwIfAborted();
      // Installers must honor this signal before committing or publishing a build.
      // Abort releases the queue even when a callback does not resolve; a stale
      // callback cannot receive permission to commit after a rollback starts.
      await abortable(
        Promise.resolve().then(() =>
          this.options.activate(artifact, phase, round.id, signal),
        ),
        signal,
      );
      signal.throwIfAborted();
    });
    this.activation = task.catch(() => {});
    try {
      await task;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async closePrepared(prepared: PreparedGame): Promise<void> {
    const cleanup = new AbortController();
    const timer = setTimeout(
      () => cleanup.abort(new Error("cleanup-timeout")),
      CLEANUP_BUDGET_MS,
    );
    try {
      await abortable(
        Promise.resolve().then(() => prepared.close()),
        cleanup.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private async headStart(round: ActiveRound): Promise<void> {
    const remaining = Math.max(
      0,
      (round.startedAt ?? this.now()) + this.headStartMs - this.now(),
    );
    if (remaining === 0) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        round.abort.signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        clearTimeout(timer);
        reject(round.abort.signal.reason);
      };
      const timer = setTimeout(done, remaining);
      round.abort.signal.addEventListener("abort", aborted, { once: true });
      if (round.abort.signal.aborted) aborted();
    });
  }
  private hint(round: ActiveRound): BugFamily | null {
    const counts = new Map<BugFamily, number>();
    for (const family of round.votes.values())
      counts.set(family, (counts.get(family) ?? 0) + 1);
    let result: BugFamily | null = null;
    let highest = 0;
    for (const family of [...counts.keys()].sort()) {
      const count = counts.get(family) ?? 0;
      if (count > highest) {
        highest = count;
        result = family;
      }
    }
    return result;
  }
  private async run(round: ActiveRound): Promise<RoundSnapshot> {
    let stage: "prepare" | "activation" | "repair" = "prepare";
    let installed: GameArtifact | null = null;
    let regression: { test: RegressionTest | null; error: string | null } = {
      test: null,
      error: null,
    };
    this.arm(round, this.hardBudgetMs, "prepare-deadline");
    try {
      const prepared = await abortable(
        this.options.runtime.prepare(
          round.id,
          round.abort.signal,
          round.selectedFamily,
        ),
        round.abort.signal,
        (late) => {
          void this.closePrepared(late).catch(() => {
            this.stopped = true;
          });
        },
      );
      round.prepared = prepared;
      stage = "activation";
      // The callback installs code without replacing the browser's world state.
      // It also publishes game.build. Presentation time begins only after install.
      round.visible = true;
      await this.activate(round, prepared.broken, "broken");
      round.startedAt = this.now();
      this.guessClosesAt = round.startedAt + this.roundLimitMs;
      this.arm(round, this.hardBudgetMs, "hard-budget");
      this.overlay({
        type: "round.started",
        id: round.id,
        number: ++this.number,
        atMs: round.startedAt,
        headStartMs: this.headStartMs,
      });
      this.overlay({ type: "bug.active", roundId: round.id, intensity: 1 });
      this.phase(round, "head-start");
      await this.headStart(round);
      round.headStartFinishedAt = this.now();
      stage = "repair";
      this.phase(round, "repairing");
      const repaired = await abortable(
        prepared.repair({
          hint: this.hint(round),
          signal: round.abort.signal,
          observe: (observation) => this.observe(round, observation),
          event: (event) => {
            if (
              this.current !== round ||
              round.abort.signal.aborted ||
              this.state.phase !== "repairing"
            )
              return;
            const observed = sdkOverlayEvent(round.id, event, this.now());
            if (observed) this.overlay(observed);
          },
        }),
        round.abort.signal,
      );
      round.abort.signal.throwIfAborted();
      // Runtime resolution guarantees full immutable visible + held-out validation.
      if (repaired.timings) round.timings = { ...repaired.timings };
      round.swapStartedAt = this.now();
      this.phase(round, "swapping");
      stage = "activation";
      await this.activate(round, repaired, "repaired");
      round.swapFinishedAt = this.now();
      installed = repaired;
    } catch {
      round.reason ??=
        stage === "prepare"
          ? "prepare-failed"
          : stage === "activation"
            ? "activation-failed"
            : "repair-failed";
      round.abort.abort(new Error(round.reason));
      await this.rollback(round);
    } finally {
      if (round.timer) clearTimeout(round.timer);
      try {
        if (round.prepared) await this.closePrepared(round.prepared);
      } catch (error) {
        round.reason =
          error instanceof Error && error.message === "cleanup-timeout"
            ? "cleanup-timeout"
            : "cleanup-failed";
        this.stopped = true;
        round.abort.abort(new Error(round.reason));
        if (installed) {
          await this.rollback(round);
          installed = null;
        } else this.phase(round, "rolled-back");
      }
      if (installed && round.abort.signal.aborted) {
        await this.rollback(round);
        installed = null;
      }
      if (installed) {
        if (
          round.winner === null &&
          (round.swapFinishedAt ?? Infinity) <
            (round.startedAt ?? 0) + this.roundLimitMs
        ) {
          round.winner = "codex";
          this.scores.codex++;
          this.overlay({ type: "score.changed", ...this.scores });
        }
        if (round.winner === null) round.reason = "round-limit";
        if (round.prepared)
          this.overlay({
            type: "bug.named",
            roundId: round.id,
            name: round.prepared.family,
          });
        this.overlay({ type: "tests.green", roundId: round.id });
        this.phase(round, "resolved");
        round.completed = true;
        regression = await this.recordRegression(round);
      }
      this.finishAutopsy(round, installed, regression.test, regression.error);
      if (this.current === round) this.current = null;
    }
    return this.snapshot();
  }
  private async rollback(round: ActiveRound): Promise<void> {
    if (round.prepared && round.visible) {
      try {
        await this.activate(round, round.prepared.clean, "rollback");
        this.overlay({ type: "bug.active", roundId: round.id, intensity: 0 });
      } catch (error) {
        round.reason =
          error instanceof Error && error.message === "rollback-timeout"
            ? "rollback-timeout"
            : "rollback-failed";
        this.stopped = true;
      }
      this.overlay({
        type: "bug.named",
        roundId: round.id,
        name: round.prepared.family,
      });
    }
    this.phase(round, "rolled-back");
  }
}
