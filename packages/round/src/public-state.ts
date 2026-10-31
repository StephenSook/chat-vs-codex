import { stepLabel } from "../../../apps/overlay/src/events.js";
import type { RoundEnvelope, RoundSession } from "./contracts.js";
import {
  deriveSeason,
  parseViewerSeason,
  type SeasonTotals,
} from "./season.js";

export const PUBLIC_PHASES = [
  "idle",
  "preparing",
  "head-start",
  "repairing",
  "validating",
  "swapping",
  "resolved",
  "rolled-back",
] as const;
export interface PublicRoundState {
  schemaVersion: 1;
  updatedAt: string;
  mode: "viewer-round" | "broadcaster-test" | "local-fixture";
  round: number;
  phase: (typeof PUBLIC_PHASES)[number];
  scores: { chat: number; codex: number };
  headStartEndsAt: number | null;
  step: { label: string; status: "running" | "done" | "failed" } | null;
  season: SeasonTotals;
}
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const safeLabel = (label: string) =>
  label.replace(/\p{Cc}/gu, " ").slice(0, 80);

/** Explicit public allowlist. Never serialize an event, SDK item, actor or replay source. */
export class PublicRoundProjection {
  private state: PublicRoundState;
  private roundId: string | null = null;
  constructor(session?: RoundSession, season = deriveSeason([]).viewers) {
    this.state = {
      schemaVersion: 1,
      updatedAt: new Date(0).toISOString(),
      mode:
        session?.mode !== "live-twitch"
          ? "local-fixture"
          : session.trigger === "broadcaster-test"
            ? "broadcaster-test"
            : "viewer-round",
      round: 0,
      phase: "idle",
      scores: { chat: 0, codex: 0 },
      headStartEndsAt: null,
      step: null,
      season: parseViewerSeason(season),
    };
  }
  updateSeason(value: SeasonTotals) {
    this.state.season = parseViewerSeason(value);
  }
  observe(envelope: RoundEnvelope) {
    const event = envelope.event;
    if (event.type === "round.state") {
      if (event.phase === "preparing") {
        this.roundId = event.roundId;
        this.state.step = null;
      }
      if (event.roundId !== this.roundId) return;
      this.state.phase = event.phase;
      this.state.headStartEndsAt =
        event.headStartEndsAt === null
          ? null
          : Math.round(
              Date.parse(envelope.wallTime ?? event.wallTime ?? "") +
                event.headStartEndsAt -
                envelope.serverTimeMs,
            );
    }
    if (event.type !== "overlay") return;
    const overlay = event.event;
    if ("roundId" in overlay && overlay.roundId !== this.roundId) return;
    if (overlay.type === "round.started") this.state.round = overlay.number;
    if (overlay.type === "score.changed")
      this.state.scores = { chat: overlay.chat, codex: overlay.codex };
    if (overlay.type === "codex.step")
      this.state.step = {
        label: safeLabel(stepLabel(overlay.step)),
        status: overlay.status,
      };
    if (overlay.type === "tests.green")
      this.state.step = { label: "Tests green", status: "done" };
  }
  snapshot(wallTime = new Date().toISOString()): PublicRoundState {
    return parsePublicRoundState({ ...this.state, updatedAt: wallTime });
  }
}

/** Shared producer/consumer parser strips every field outside the public contract. */
export function parsePublicRoundState(value: unknown): PublicRoundState {
  if (!value || typeof value !== "object")
    throw new Error("Invalid public round state");
  const state = value as PublicRoundState;
  if (
    state.schemaVersion !== 1 ||
    !Number.isFinite(Date.parse(state.updatedAt)) ||
    !["viewer-round", "broadcaster-test", "local-fixture"].includes(
      state.mode,
    ) ||
    !count(state.round) ||
    !PUBLIC_PHASES.includes(state.phase) ||
    !state.scores ||
    !count(state.scores.chat) ||
    !count(state.scores.codex) ||
    (state.headStartEndsAt !== null &&
      (!Number.isSafeInteger(state.headStartEndsAt) ||
        state.headStartEndsAt < 0)) ||
    (state.step !== null &&
      (!state.step ||
        typeof state.step.label !== "string" ||
        state.step.label.length > 80 ||
        !["running", "done", "failed"].includes(state.step.status)))
  )
    throw new Error("Invalid public round state");
  return {
    schemaVersion: 1,
    updatedAt: state.updatedAt,
    mode: state.mode,
    round: state.round,
    phase: state.phase,
    scores: { chat: state.scores.chat, codex: state.scores.codex },
    headStartEndsAt: state.headStartEndsAt,
    step: state.step
      ? { label: safeLabel(state.step.label), status: state.step.status }
      : null,
    season: parseViewerSeason(state.season),
  };
}
