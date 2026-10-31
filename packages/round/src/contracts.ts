import type { ThreadEvent } from "@openai/codex-sdk";
import type { OverlayEvent } from "../../../apps/overlay/src/events.js";
import type { ValidatedReplay } from "../../bench/src/validated-replay.js";
import type { MutationProvenance } from "../../mutator/src/live.js";
import type { BugFamily } from "../../twitch/src/events.js";

export const ROUND_INPUTS = [
  "chat",
  "channel-points",
  "whisper",
  "raid",
  "power-up",
] as const;
export type RoundInput = (typeof ROUND_INPUTS)[number];
export function isRoundInput(value: unknown): value is RoundInput {
  return (
    typeof value === "string" && ROUND_INPUTS.includes(value as RoundInput)
  );
}

/** Host-owned session identity, sent on each SSE connection before round events. */
export interface RoundSession {
  mode: "local-fixture" | "live-twitch";
  trigger?: "broadcaster-test";
}

export interface SymptomReplay {
  fps: 60;
  buildDigest: string;
  sourceDigest: string;
  trackDigest: string;
  firstDivergentFrame: number;
  focus: "player" | "enemy";
  frames: {
    frame: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    alive: boolean;
    won: boolean;
    enemy: {
      x: number;
      y: number;
      vy: number;
      direction: number;
      turns: number;
    };
  }[];
}

export type BossModel = "sol" | "terra";
export interface BossThreadResult {
  model: BossModel;
  status: "validated" | "failed";
  timings: Partial<RuntimeTimings>;
  patch: RuntimePatch | null;
  failure: "repair-failed" | null;
}
export interface BossReceipt {
  winner: BossModel | null;
  memory: {
    freeBytes: number;
    /** Darwin free + inactive + speculative pages; raw freeBytes is retained. */
    availableBytes?: number;
    measurementError?: "vm-stat-unavailable";
    rssBytes: number;
    minimumFreeBytes: number;
    measuredAtMs: number;
  };
  threads: BossThreadResult[];
}

/** Shared wire guard: receipts and browser presentation accept only measured results. */
export function validBossReceipt(
  value: unknown,
  incomplete = false,
): value is BossReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as BossReceipt;
  const measured = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (
    !record.memory ||
    record.memory.measurementError !== undefined ||
    ![
      record.memory.freeBytes,
      record.memory.rssBytes,
      record.memory.minimumFreeBytes,
      record.memory.measuredAtMs,
    ].every(measured) ||
    (record.memory.availableBytes !== undefined &&
      !measured(record.memory.availableBytes)) ||
    !Array.isArray(record.threads) ||
    record.threads.length > 2 ||
    (!incomplete && record.threads.length !== 2) ||
    new Set(record.threads.map((thread) => thread?.model)).size !==
      record.threads.length ||
    (record.winner !== null && !["sol", "terra"].includes(record.winner))
  )
    return false;
  for (const thread of record.threads) {
    if (
      !thread ||
      !["sol", "terra"].includes(thread.model) ||
      !["validated", "failed"].includes(thread.status) ||
      !thread.timings ||
      Array.isArray(thread.timings) ||
      typeof thread.timings !== "object" ||
      Object.values(thread.timings).some((n) => !measured(n)) ||
      thread.failure !==
        (thread.status === "validated" ? null : "repair-failed")
    )
      return false;
    if (
      thread.patch !== null &&
      (!thread.patch ||
        !Number.isSafeInteger(thread.patch.added) ||
        thread.patch.added < 0 ||
        !Number.isSafeInteger(thread.patch.removed) ||
        thread.patch.removed < 0 ||
        !Array.isArray(thread.patch.preview) ||
        thread.patch.preview.length > 4 ||
        thread.patch.preview.some(
          (line) => typeof line !== "string" || line.includes("\n"),
        ))
    )
      return false;
    if (thread.status === "validated") {
      const times = [
        thread.timings.threadStartedAtMs,
        thread.timings.patchReadyAtMs,
        thread.timings.validationStartedAtMs,
        thread.timings.validationFinishedAtMs,
      ];
      if (
        !times.every(measured) ||
        times.some(
          (time, index) => index > 0 && Number(time) < Number(times[index - 1]),
        )
      )
        return false;
    }
  }
  if (!incomplete || record.winner !== null) {
    const starts = record.threads.map(
      (thread) => thread.timings.threadStartedAtMs,
    );
    if (
      record.winner === null ||
      starts.length !== 2 ||
      !starts.every(measured) ||
      Math.max(...starts.map(Number)) - Math.min(...starts.map(Number)) > 1000
    )
      return false;
  }
  return (
    record.winner === null ||
    record.threads.some(
      (thread) =>
        thread.model === record.winner && thread.status === "validated",
    )
  );
}

export interface GameArtifact {
  id: string;
  code: string;
  digest: string;
  timings?: RuntimeTimings;
  diagnosis?: RuntimeDiagnosis;
  patch?: RuntimePatch;
  replay?: RoundValidationReplay;
}

export interface RoundValidationReplay extends ValidatedReplay {
  /** SHA-256 over the submitted source snapshot that produced these frames. */
  sourceDigest: string;
}

export interface RuntimeDiagnosis {
  headline?: string;
  rootCause: string;
  file: string;
  line: number;
  explanation: string;
  confidence: number;
}

export interface RuntimePatch {
  added: number;
  removed: number;
  /** Actual source diff lines, capped at four. Never includes file headers. */
  preview: string[];
}

export interface RuntimeTimings {
  threadStartedAtMs: number;
  patchReadyAtMs: number;
  validationStartedAtMs: number;
  validationFinishedAtMs: number;
}

export interface RuntimePhaseObservation {
  type: "runtime.phase";
  phase:
    | "thread-started"
    | "patch-ready"
    | "validation-started"
    | "validation-passed";
  atMs: number;
  wallTime: string;
}

export type RuntimeObservation =
  | RuntimePhaseObservation
  | {
      type: "runtime.replay";
      replay: RoundValidationReplay;
      atMs: number;
      wallTime: string;
    }
  | {
      type: "runtime.patch";
      patch: RuntimePatch;
      atMs: number;
      wallTime: string;
    };

export interface RoundDurations {
  headStartMs: number | null;
  repairMs: number | null;
  validationMs: number | null;
  swapMs: number | null;
  timeToGreenMs: number | null;
}

export interface RegressionTest {
  path: string;
  digest: string;
}

/** Terminal evidence. Missing runtime metadata remains unavailable, never inferred. */
export interface RoundAutopsy {
  roundId: string;
  /** Absent only on receipts recorded before input provenance. */
  input?: RoundInput;
  boss?: BossReceipt;
  trigger?: "broadcaster-test";
  status: "verified" | "rolled-back";
  reason: string | null;
  breaker: string | null;
  firstCorrectGuesser: string | null;
  /** Live presentation only; never retained in public receipts. */
  displayNames?: { breaker: string | null; firstCorrectGuesser: string | null };
  family: BugFamily | null;
  winner: "chat" | "codex" | null;
  patch: RuntimePatch | null;
  explanation: string | null;
  /** SDK-authored concise summary; unavailable on legacy rounds. */
  headline?: string | null;
  durations: RoundDurations;
  previousRoundId: string | null;
  /** Current minus previous compatible time to green; negative means faster. */
  deltaMs: number | null;
  regressionTest: RegressionTest | null;
  regressionError: string | null;
}

export interface PreviousVerifiedRound {
  roundId: string;
  /** Null for legacy or incompatible timing definitions. */
  timeToGreenMs: number | null;
}

export interface PreparedGame {
  symptom?: SymptomReplay;
  mutation?: MutationProvenance;
  family: BugFamily;
  clean: GameArtifact;
  broken: GameArtifact;
  /** Resolves only after sandboxed typecheck, full replays and held-out replay,
   * and immutable tests, tooling and one-commit history have all been verified. */
  repair(options: {
    hint: BugFamily | null;
    signal: AbortSignal;
    event: (event: ThreadEvent) => void;
    observe?: (observation: RuntimeObservation) => void;
  }): Promise<GameArtifact>;
  boss?: BossReceipt;
  settleBoss?(): Promise<void>;
  repairBoss?(options: {
    hint: BugFamily | null;
    signal: AbortSignal;
    event: (event: ThreadEvent, model: BossModel) => void;
    observe?: (observation: RuntimeObservation, model: BossModel) => void;
  }): Promise<GameArtifact>;
  close(): Promise<void>;
  /** Host-owned persistence after verified install and cleanup. Never runs in Codex. */
  recordRegression?(credit: {
    roundId: string;
    viewer: string;
  }): Promise<RegressionTest>;
}

export interface RoundRuntime {
  prepare(
    roundId: string,
    signal: AbortSignal,
    family?: BugFamily,
    boss?: BossReceipt,
  ): Promise<PreparedGame>;
}

type RoundEventPayload =
  | {
      type: "round.boss-winner";
      roundId: string;
      model: BossModel;
      family: BugFamily;
      timeToGreenMs: number;
    }
  | {
      type: "round.boss-memory";
      roundId: null;
      memory: BossReceipt["memory"];
      accepted: boolean;
    }
  | { type: "round.mutation"; roundId: string; mutation: MutationProvenance }
  | { type: "overlay"; event: OverlayEvent }
  | {
      type: "game.build";
      roundId: string;
      buildId: string;
      digest: string;
      sourceDigest?: string;
      phase: "broken" | "repaired" | "rollback";
    }
  | {
      type: "round.state";
      roundId: string | null;
      phase:
        | "idle"
        | "preparing"
        | "head-start"
        | "repairing"
        | "validating"
        | "swapping"
        | "resolved"
        | "rolled-back";
      headStartEndsAt: number | null;
      winner: "chat" | "codex" | null;
      reason: string | null;
      durations?: RoundDurations;
    };

export type RoundEvent = RoundEventPayload & {
  input?: RoundInput;
  trigger?: "broadcaster-test";
  atMs?: number;
  wallTime?: string;
};

export interface RoundEnvelope {
  sequence: number;
  input?: RoundInput;
  trigger?: "broadcaster-test";
  serverTimeMs: number;
  atMs?: number;
  wallTime?: string;
  /** Current server clock at SSE delivery; recorded event clocks remain unchanged. */
  deliveryAtMs?: number;
  event: RoundEvent;
}
