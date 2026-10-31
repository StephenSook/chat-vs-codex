import type { ThreadEvent } from "@openai/codex-sdk";
import type { OverlayEvent } from "../../../apps/overlay/src/events.js";
import type { BugFamily } from "../../twitch/src/events.js";

export interface GameArtifact {
  id: string;
  code: string;
  digest: string;
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
  }): Promise<GameArtifact>;
  close(): Promise<void>;
}

export interface RoundRuntime {
  prepare(roundId: string, signal: AbortSignal): Promise<PreparedGame>;
}

export type RoundEvent =
  | { type: "overlay"; event: OverlayEvent }
  | {
      type: "game.build";
      roundId: string;
      buildId: string;
      digest: string;
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
    };

export interface RoundEnvelope {
  sequence: number;
  serverTimeMs: number;
  event: RoundEvent;
}
