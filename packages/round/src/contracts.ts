import type { ThreadEvent } from "@openai/codex-sdk";
import type { OverlayEvent } from "../../../apps/overlay/src/events.js";
import type { ValidatedReplay } from "../../bench/src/validated-replay.js";
import type { BugFamily } from "../../twitch/src/events.js";

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
  status: "verified" | "rolled-back";
  reason: string | null;
  breaker: string | null;
  firstCorrectGuesser: string | null;
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
  close(): Promise<void>;
  /** Host-owned persistence after verified install and cleanup. Never runs in Codex. */
  recordRegression?(credit: {
    roundId: string;
    viewer: string;
  }): Promise<RegressionTest>;
}

export interface RoundRuntime {
  prepare(roundId: string, signal: AbortSignal): Promise<PreparedGame>;
}

type RoundEventPayload =
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
  atMs?: number;
  wallTime?: string;
};

export interface RoundEnvelope {
  sequence: number;
  serverTimeMs: number;
  atMs?: number;
  wallTime?: string;
  /** Current server clock at SSE delivery; recorded event clocks remain unchanged. */
  deliveryAtMs?: number;
  event: RoundEvent;
}
