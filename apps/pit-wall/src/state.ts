import type { ServerFrame, State } from "@chat-vs-codex/pit-wall/protocol";

export type Connection = "offline" | "connecting" | "pairing" | "live";
export interface PhoneState {
  connection: Connection;
  sequence: number;
  serverTimeMs: number;
  clockOffsetMs: number;
  round: State | null;
  notifiedRounds: string[];
  alertRoundId: string | null;
  pending: { id: string; roundId: string } | null;
  message: string | null;
}

export const initialPhoneState: PhoneState = {
  connection: "offline",
  sequence: -1,
  serverTimeMs: -1,
  clockOffsetMs: 0,
  round: null,
  notifiedRounds: [],
  alertRoundId: null,
  pending: null,
  message: null,
};

export type PhoneAction =
  | { type: "connecting" }
  | { type: "opened" }
  | { type: "disconnected"; reason: string }
  | { type: "frame"; frame: ServerFrame; receivedAt: number }
  | { type: "pending"; id: string; roundId: string }
  | { type: "message"; message: string }
  | { type: "forget" };

export function phoneReducer(
  state: PhoneState,
  action: PhoneAction,
): PhoneState {
  switch (action.type) {
    case "connecting":
      return { ...state, connection: "connecting", message: null };
    case "opened":
      // A runner restart creates a new sequence namespace. Callbacks from retired
      // sockets are rejected by the connection owner before reaching this reducer.
      return {
        ...state,
        connection: "pairing",
        sequence: -1,
        serverTimeMs: -1,
      };
    case "disconnected":
      return {
        ...state,
        connection: "offline",
        pending: null,
        message: action.reason,
      };
    case "message":
      return { ...state, message: action.message };
    case "forget":
      return { ...initialPhoneState };
    case "pending":
      if (
        state.connection !== "live" ||
        state.round?.roundId !== action.roundId ||
        state.pending
      )
        return state;
      return {
        ...state,
        pending: { id: action.id, roundId: action.roundId },
        message: "Sending...",
      };
    case "frame": {
      const frame = action.frame;
      if (frame.type === "paired") return state;
      if (frame.type === "error")
        return { ...state, message: frame.reason, pending: null };
      if (frame.type === "ack") {
        if (state.pending?.id !== frame.id) return state;
        return {
          ...state,
          pending: null,
          message: frame.accepted ? "Accepted" : frame.reason,
        };
      }
      if (
        frame.sequence <= state.sequence ||
        frame.serverTimeMs < state.serverTimeMs
      )
        return state;
      const roundId = frame.state.roundId;
      const alert =
        frame.state.bug === "active" &&
        roundId !== null &&
        !state.notifiedRounds.includes(roundId);
      return {
        ...state,
        connection: "live",
        sequence: frame.sequence,
        serverTimeMs: frame.serverTimeMs,
        clockOffsetMs: action.receivedAt - frame.serverTimeMs,
        round: frame.state,
        alertRoundId: alert ? roundId : state.alertRoundId,
        notifiedRounds: alert
          ? [...state.notifiedRounds, roundId].slice(-128)
          : state.notifiedRounds,
        pending: state.pending?.roundId === roundId ? state.pending : null,
        message: state.round?.roundId === roundId ? state.message : null,
      };
    }
  }
}

export function countdownSeconds(state: PhoneState, phoneNow: number): number {
  if (
    state.connection !== "live" ||
    state.round?.phase !== "head-start" ||
    state.round.headStartEndsAt === null
  )
    return 0;
  return Math.max(
    0,
    Math.ceil(
      (state.round.headStartEndsAt + state.clockOffsetMs - phoneNow) / 1000,
    ),
  );
}

export function canVeto(state: PhoneState): boolean {
  return (
    state.connection === "live" &&
    !state.pending &&
    state.round?.roundId !== null &&
    (state.round?.phase === "preparing" || state.round?.phase === "head-start")
  );
}

export function canHint(state: PhoneState): boolean {
  return (
    state.connection === "live" &&
    !state.pending &&
    state.round?.roundId !== null &&
    (state.round?.phase === "preparing" || state.round?.phase === "head-start")
  );
}

export function gatewayUrl(host: string): string | null {
  // A saved bearer token must never be redirected by a URL path/userinfo. Port
  // and scheme are fixed; the streamer enters only their Mac's LAN IPv4 address.
  const parts = host.trim().split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (
    !(
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second >= 16 && second <= 31)
    )
  )
    return null;
  return `ws://${parts.map(Number).join(".")}:4318`;
}

export function nativePayload(state: PhoneState, foreground: boolean) {
  // Leave the last received Activity visible when the app is suspended. Native
  // stale/expiry clocks run without JS; no background freshness is claimed.
  if (!foreground) return null;
  const round = state.round;
  return {
    active:
      state.connection === "live" && !!round?.roundId && round.phase !== "idle",
    roundId: round?.roundId ?? "",
    phase: round?.phase ?? "idle",
    chatScore: round?.chat ?? 0,
    codexScore: round?.codex ?? 0,
    deaths: round?.deaths ?? 0,
    headStartEndsAt:
      round?.headStartEndsAt == null
        ? null
        : round.headStartEndsAt + state.clockOffsetMs,
    step: round?.step ?? "",
    headline: round?.headline ?? "",
  };
}
