import type { RoundAutopsy } from "../../../packages/round/src/contracts.js";

/** Local presentation contract. The operator's SDK bridge publishes observed events only.
 * No timer manufactures agent activity, scores, guesses, or a passing test result.
 */
export const CODEX_ACTIONS = [
  "discover",
  "edit",
  "edit-test",
  "command",
  "tool",
  "respond",
  "reason",
  "search",
  "plan",
  "error",
] as const;
export type CodexAction = (typeof CODEX_ACTIONS)[number];

export type CodexStep =
  | { kind: "reading"; path: string }
  | { kind: "replay" }
  | { kind: "patch"; added: number; removed: number }
  | { kind: "tests" }
  | { kind: "activity"; action: CodexAction };

export type OverlayEvent =
  | { type: "round.preparing"; id: string }
  | {
      type: "round.started";
      id: string;
      number: number;
      atMs: number;
      headStartMs?: number;
    }
  | { type: "bug.active"; roundId: string; intensity: number }
  | { type: "bug.named"; roundId: string; name: string }
  | {
      type: "codex.step";
      roundId: string;
      id: string;
      step: CodexStep;
      status: "running" | "done" | "failed";
      attempt: number;
      total: number;
    }
  | { type: "tests.green"; roundId: string }
  | { type: "round.autopsy"; roundId: string; autopsy: RoundAutopsy }
  | { type: "score.changed"; chat: number; codex: number }
  | { type: "simulation.death" };

export interface OverlayEventBus {
  publish(event: OverlayEvent): void;
  subscribe(listener: (event: OverlayEvent) => void): () => void;
}

export function createEventBus(): OverlayEventBus {
  const listeners = new Set<(event: OverlayEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface DisplayStep {
  id: string;
  label: string;
  status: "running" | "done" | "failed";
}

export interface BroadcastState {
  roundId: string | null;
  round: number;
  startedAtMs: number | null;
  headStartMs: number;
  chat: number;
  codex: number;
  deaths: number;
  bug: "none" | "active" | "fixed";
  bugName: string | null;
  intensity: number;
  steps: readonly DisplayStep[];
  attempt: number | null;
  total: number | null;
  autopsy: RoundAutopsy | null;
}

export function initialBroadcast(): BroadcastState {
  return {
    roundId: null,
    round: 0,
    startedAtMs: null,
    headStartMs: 15000,
    chat: 0,
    codex: 0,
    deaths: 0,
    bug: "none",
    bugName: null,
    intensity: 0,
    steps: [],
    attempt: null,
    total: null,
    autopsy: null,
  };
}

export function stepLabel(step: CodexStep): string {
  switch (step.kind) {
    case "reading":
      return `Reading ${step.path.split(/[\\/]/).at(-1) || "file"}`;
    case "replay":
      return "Running replay";
    case "patch":
      return `Patch +${step.added} / -${step.removed}`;
    case "tests":
      return "Running tests";
    case "activity":
      return {
        discover: "Inspecting files",
        edit: "Editing source",
        "edit-test": "Editing + testing",
        command: "Running command",
        tool: "Using tool",
        respond: "Preparing response",
        reason: "Reviewing bug",
        search: "Searching",
        plan: "Updating plan",
        error: "Codex reported an error",
      }[step.action];
  }
}

export function reduceBroadcast(
  state: BroadcastState,
  event: OverlayEvent,
): BroadcastState {
  if ("roundId" in event && event.roundId !== state.roundId) return state;
  switch (event.type) {
    case "round.preparing":
      return {
        ...initialBroadcast(),
        roundId: event.id,
        chat: state.chat,
        codex: state.codex,
      };
    case "round.started":
      return {
        ...initialBroadcast(),
        chat: state.chat,
        codex: state.codex,
        roundId: event.id,
        round: event.number,
        startedAtMs: event.atMs,
        headStartMs:
          event.headStartMs === undefined
            ? 15000
            : Math.max(
                0,
                Number.isFinite(event.headStartMs) ? event.headStartMs : 15000,
              ),
      };
    case "score.changed":
      return { ...state, chat: event.chat, codex: event.codex };
    case "simulation.death":
      return { ...state, deaths: state.deaths + 1 };
    case "bug.active":
      return {
        ...state,
        bug: "active",
        intensity: Number.isFinite(event.intensity)
          ? Math.max(0, Math.min(1, event.intensity))
          : 0,
      };
    case "bug.named":
      return { ...state, bugName: event.name };
    case "tests.green":
      return {
        ...state,
        bug: "fixed",
        intensity: 0,
        steps: [
          ...state.steps.filter((row) => row.id !== "validated-tests"),
          {
            id: "validated-tests",
            label: "Tests green",
            status: "done" as const,
          },
        ].slice(-4),
      };
    case "round.autopsy":
      return event.autopsy.roundId === state.roundId
        ? { ...state, autopsy: event.autopsy }
        : state;
    case "codex.step": {
      // A late completion from an earlier SDK retry cannot replace the current attempt.
      if (state.attempt !== null && event.attempt < state.attempt) return state;
      const rows =
        state.attempt === event.attempt
          ? state.steps.filter((row) => row.id !== event.id)
          : [];
      const label =
        event.step.kind === "tests" && event.status === "done"
          ? "Tests passed"
          : event.step.kind === "activity" &&
              event.step.action === "edit-test" &&
              event.status === "done"
            ? "Edit/test command passed"
            : stepLabel(event.step);
      return {
        ...state,
        steps: [...rows, { id: event.id, label, status: event.status }].slice(
          -4,
        ),
        attempt: event.attempt,
        total: event.total,
      };
    }
  }
}

export function headStartSeconds(
  state: BroadcastState,
  nowMs: number,
): number | null {
  if (state.startedAtMs === null) return null;
  return Math.max(
    0,
    Math.min(
      Math.ceil(state.headStartMs / 1000),
      Math.ceil((state.startedAtMs + state.headStartMs - nowMs) / 1000),
    ),
  );
}
