import {
  type PublicRoundState,
  parsePublicRoundState,
} from "../../../packages/round/src/public-state.js";

export interface ExtensionHelper {
  onAuthorized(callback: (auth: { channelId: string }) => void): void;
  listen(
    topic: "broadcast",
    callback: (target: string, contentType: string, message: string) => void,
  ): void;
  unlisten(
    topic: "broadcast",
    callback: (target: string, contentType: string, message: string) => void,
  ): void;
  onVisibilityChanged(callback: (visible: boolean) => void): void;
}
export function parsePanelMessage(message: string): PublicRoundState {
  if (message.length > 5000) throw new Error("Invalid panel message");
  return parsePublicRoundState(JSON.parse(message));
}
export function panelView(state: PublicRoundState | null, nowMs: number) {
  if (
    !state ||
    nowMs - Date.parse(state.updatedAt) > 10000 ||
    Date.parse(state.updatedAt) - nowMs > 10000
  )
    return {
      connection: "Waiting for round data",
      label: "",
      score: "CHAT 0 : CODEX 0",
      phase: "No round data",
      step: "",
      season: "SEASON · No data",
    };
  return {
    connection: "Connected",
    label:
      state.mode === "broadcaster-test"
        ? "TEST ROUND"
        : state.mode === "local-fixture"
          ? "LOCAL FIXTURE"
          : `ROUND ${state.round}`,
    score: `CHAT ${state.scores.chat} : CODEX ${state.scores.codex}`,
    phase:
      state.phase === "head-start" && state.headStartEndsAt !== null
        ? `CHAT ${Math.max(0, Math.ceil((state.headStartEndsAt - nowMs) / 1000))} s`
        : {
            idle: "Ready",
            preparing: "Preparing",
            "head-start": "Chat head start",
            repairing: "Codex is in",
            validating: "Testing patch",
            swapping: "Landing fix",
            resolved: "Round resolved",
            "rolled-back": "Rolled back",
          }[state.phase],
    step: state.step
      ? `${state.step.label}${state.step.status === "failed" ? " · FAILED" : ""}`
      : "",
    season: `SEASON · CHAT ${state.season.chatWins} : CODEX ${state.season.codexWins}`,
  };
}

/** No viewer identity, JWT, local host URL, storage or outbound requests are needed. */
export function connectPanel(
  helper: ExtensionHelper,
  render: (state: PublicRoundState | null) => void,
  now: () => number = Date.now,
) {
  let listening = false;
  let stopped = false;
  let newest = Number.NEGATIVE_INFINITY;
  let visible = true;
  const receive = (_target: string, contentType: string, message: string) => {
    if (stopped || contentType !== "application/json" || !visible) return;
    try {
      const state = parsePanelMessage(message);
      const stamp = Date.parse(state.updatedAt);
      const current = now();
      // Reject invalid clock excursions before they can poison the ordering watermark.
      if (
        !Number.isFinite(current) ||
        stamp > current + 10000 ||
        current - stamp > 10000 ||
        stamp < newest
      )
        return;
      newest = stamp;
      render(state);
    } catch {
      /* Untrusted/malformed transport never replaces the last valid state. */
    }
  };
  helper.onAuthorized(() => {
    if (!stopped && !listening) {
      listening = true;
      helper.listen("broadcast", receive);
    }
  });
  helper.onVisibilityChanged((value) => {
    visible = value;
  });
  return () => {
    stopped = true;
    if (listening) helper.unlisten("broadcast", receive);
    listening = false;
  };
}
