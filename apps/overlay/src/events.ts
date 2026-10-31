import type {
  BossModel,
  RoundAutopsy,
  RoundValidationReplay,
  SymptomReplay,
} from "../../../packages/round/src/contracts.js";

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
  | { kind: "tool"; name: string; summary?: string }
  | { kind: "activity"; action: CodexAction };

export type OverlayEvent =
  | { type: "boss.note"; text: "BOSS PAUSED · LOW MEMORY" }
  | { type: "boss.started"; roundId: string }
  | { type: "boss.predictions"; roundId: string; sol: number; terra: number }
  | { type: "twitch.raid"; viewers: number }
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
      model?: BossModel;
      roundId: string;
      id: string;
      startedAtMs?: number;
      step: CodexStep;
      status: "running" | "done" | "failed";
      attempt: number;
      total: number;
    }
  | { type: "tests.green"; roundId: string }
  | { type: "round.autopsy"; roundId: string; autopsy: RoundAutopsy }
  | { type: "round.symptom"; roundId: string; replay: SymptomReplay }
  | { type: "round.ghost"; roundId: string; replay: RoundValidationReplay }
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
  startedAtMs?: number;
  id: string;
  label: string;
  status: "running" | "done" | "failed";
}

export interface BroadcastState {
  boss: {
    sol: readonly DisplayStep[];
    terra: readonly DisplayStep[];
    predictions: { sol: number; terra: number };
  } | null;
  bossNote: string | null;
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
  stepStarts: Readonly<Record<string, number>>;
  attempt: number | null;
  total: number | null;
  autopsy: RoundAutopsy | null;
  ghost: RoundValidationReplay | null;
  raidViewers: number | null;
}

export function initialBroadcast(): BroadcastState {
  return {
    boss: null,
    bossNote: null,
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
    stepStarts: {},
    attempt: null,
    total: null,
    autopsy: null,
    ghost: null,
    raidViewers: null,
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
    case "tool":
      return step.summary
        ? `${step.name}: ${step.summary}`
        : `Tool: ${step.name}`;
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
    case "boss.note":
      return { ...state, bossNote: event.text };
    case "boss.started":
      return {
        ...state,
        boss: { sol: [], terra: [], predictions: { sol: 0, terra: 0 } },
      };
    case "boss.predictions":
      return state.boss
        ? {
            ...state,
            boss: {
              ...state.boss,
              predictions: { sol: event.sol, terra: event.terra },
            },
          }
        : state;
    case "twitch.raid":
      return { ...state, raidViewers: event.viewers };
    case "round.preparing":
      return {
        ...initialBroadcast(),
        roundId: event.id,
        raidViewers: state.raidViewers,
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
        raidViewers: state.raidViewers,
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
        ? {
            ...state,
            autopsy: event.autopsy,
            raidViewers: null,
            ghost: event.autopsy.status === "rolled-back" ? null : state.ghost,
          }
        : state;
    case "round.symptom":
      return state;
    case "round.ghost":
      return { ...state, ghost: event.replay };
    case "codex.step": {
      if (event.model && state.boss) {
        const model = event.model;
        const { model: _model, ...ordinary } = event;
        const reduced = reduceBroadcast(
          {
            ...state,
            boss: null,
            steps: state.boss[model],
            attempt: event.attempt,
            stepStarts: Object.fromEntries(
              state.boss[model].flatMap((row) =>
                row.startedAtMs === undefined
                  ? []
                  : [[`id:${row.id}`, row.startedAtMs]],
              ),
            ),
          },
          ordinary,
        );
        return { ...state, boss: { ...state.boss, [model]: reduced.steps } };
      }
      // A late completion from an earlier SDK retry cannot replace the current attempt.
      if (state.attempt !== null && event.attempt < state.attempt) return state;
      const startKey = `id:${event.id}`;
      const starts = state.attempt === event.attempt ? state.stepStarts : {};
      const startedAtMs = starts[startKey] ?? event.startedAtMs;
      const stepStarts =
        startedAtMs === undefined
          ? starts
          : { ...starts, [startKey]: startedAtMs };
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
        stepStarts,
        steps: [
          ...rows,
          {
            id: event.id,
            label,
            status: event.status,
            ...(startedAtMs === undefined ? {} : { startedAtMs }),
          },
        ]
          .sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0))
          .slice(-4),
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
