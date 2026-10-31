/** Deliberately small phone contract. No Twitch payloads, source, or runtime logs. */
export const BUG_FAMILIES = [
  "gravity-sign",
  "collision-off-by-one",
  "swapped-controls",
  "coyote-never-expires",
  "jump-buffer",
  "enemy-ledge-turn",
] as const;
export type BugFamily = (typeof BUG_FAMILIES)[number];
export const PHASES = [
  "idle",
  "preparing",
  "head-start",
  "repairing",
  "validating",
  "swapping",
  "resolved",
  "rolled-back",
] as const;
export interface State {
  roundId: string | null;
  number: number;
  phase: (typeof PHASES)[number];
  /** Server monotonic milliseconds, translated using serverTimeMs on receipt. */
  headStartEndsAt: number | null;
  chat: number;
  codex: number;
  deaths: number;
  bug: "none" | "active" | "fixed";
  bugName: string | null;
  step: string | null;
  headline: string | null;
}
export function initialState(): State {
  return {
    roundId: null,
    number: 0,
    phase: "idle",
    headStartEndsAt: null,
    chat: 0,
    codex: 0,
    deaths: 0,
    bug: "none",
    bugName: null,
    step: null,
    headline: null,
  };
}
export type Action = { type: "action"; id: string; roundId: string } & (
  | { action: "veto" }
  | { action: "hint"; family: BugFamily }
);
export type ClientFrame =
  | { type: "pair"; code: string }
  | { type: "auth"; token: string }
  | Action;
export type ServerFrame =
  | { type: "paired"; token: string }
  | { type: "state"; sequence: number; serverTimeMs: number; state: State }
  | { type: "ack"; id: string; accepted: boolean; reason: string }
  | { type: "error"; reason: string };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const natural = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const text = (v: unknown, max = 240): v is string =>
  typeof v === "string" && v.length <= max;
const nullableText = (v: unknown) => v === null || text(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);
export function parseClientFrame(v: unknown): ClientFrame | null {
  if (!object(v)) return null;
  if (
    v.type === "pair" &&
    exact(v, ["type", "code"]) &&
    typeof v.code === "string" &&
    /^\d{6}$/.test(v.code)
  )
    return v as ClientFrame;
  if (
    v.type === "auth" &&
    exact(v, ["type", "token"]) &&
    typeof v.token === "string" &&
    /^[a-f0-9]{64}$/.test(v.token)
  )
    return v as ClientFrame;
  if (
    v.type !== "action" ||
    !text(v.id, 80) ||
    !v.id ||
    !text(v.roundId, 80) ||
    !v.roundId
  )
    return null;
  if (v.action === "veto" && exact(v, ["type", "id", "roundId", "action"]))
    return v as Action;
  if (
    v.action === "hint" &&
    exact(v, ["type", "id", "roundId", "action", "family"]) &&
    BUG_FAMILIES.includes(v.family as BugFamily)
  )
    return v as Action;
  return null;
}
export function parseServerFrame(v: unknown): ServerFrame | null {
  if (!object(v)) return null;
  if (
    v.type === "paired" &&
    typeof v.token === "string" &&
    /^[a-f0-9]{64}$/.test(v.token)
  )
    return { type: "paired", token: v.token };
  if (v.type === "error" && text(v.reason))
    return { type: "error", reason: v.reason };
  if (
    v.type === "ack" &&
    text(v.id, 80) &&
    typeof v.accepted === "boolean" &&
    text(v.reason)
  )
    return { type: "ack", id: v.id, accepted: v.accepted, reason: v.reason };
  if (
    v.type !== "state" ||
    !natural(v.sequence) ||
    !finite(v.serverTimeMs) ||
    !object(v.state)
  )
    return null;
  const s = v.state;
  if (
    !nullableText(s.roundId) ||
    !natural(s.number) ||
    !PHASES.includes(s.phase as State["phase"]) ||
    !(s.headStartEndsAt === null || finite(s.headStartEndsAt)) ||
    !natural(s.chat) ||
    !natural(s.codex) ||
    !natural(s.deaths) ||
    !["none", "active", "fixed"].includes(String(s.bug)) ||
    !nullableText(s.bugName) ||
    !nullableText(s.step) ||
    !nullableText(s.headline)
  )
    return null;
  // Pick fields instead of forwarding an untrusted object to native code.
  return {
    type: "state",
    sequence: v.sequence,
    serverTimeMs: v.serverTimeMs,
    state: {
      roundId: s.roundId as string | null,
      number: s.number,
      phase: s.phase as State["phase"],
      headStartEndsAt: s.headStartEndsAt as number | null,
      chat: s.chat,
      codex: s.codex,
      deaths: s.deaths,
      bug: s.bug as State["bug"],
      bugName: s.bugName as string | null,
      step: s.step as string | null,
      headline: s.headline as string | null,
    },
  };
}
