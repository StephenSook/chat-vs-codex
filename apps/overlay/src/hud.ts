import { type BroadcastState, headStartSeconds } from "./events.js";
import { autopsyView } from "./presentation.js";

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing overlay element: ${id}`);
  return found as T;
}

export function resizeStage(): void {
  // Numeric JS scale also works in OBS Chromium versions without CSS division.
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  element("stage").style.transform = `translate(-50%, -50%) scale(${scale})`;
}

export function renderBroadcast(state: BroadcastState): void {
  element("chat-score").textContent = String(state.chat);
  element("codex-score").textContent = String(state.codex);
  element("death-count").textContent = String(state.deaths);
  element("round-label").textContent = state.roundId
    ? state.round > 0
      ? `ROUND ${state.round}`
      : state.autopsy
        ? "ROUND AUTOPSY"
        : "PREPARING ROUND"
    : "SIM REPLAY";
  element("bug-name").textContent =
    state.bug === "fixed"
      ? "Fixed"
      : (state.bugName ?? (state.bug === "active" ? "???" : "No active bug"));
  element("bug-glyph").textContent =
    state.bug === "fixed" ? "✓" : state.bug === "active" ? "ϟ" : "○";
  element("bug-ticket").dataset.status = state.bug;
  element("game").dataset.status = state.bug;
  const list = element("steps");
  list.replaceChildren();
  if (!state.steps.length) {
    const row = document.createElement("li");
    row.className = "waiting";
    row.textContent = "○ Waiting for Codex";
    list.append(row);
  }
  for (const step of state.steps) {
    const row = document.createElement("li");
    row.dataset.status = step.status;
    const glyph = document.createElement("span");
    glyph.className = "step-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent =
      step.status === "done" ? "✓" : step.status === "failed" ? "ϟ" : "◌";
    const label = document.createElement("span");
    label.className = "step-label";
    label.textContent =
      step.status === "failed" ? `[FAILED] ${step.label}` : step.label;
    label.title = label.textContent;
    row.append(glyph, label);
    list.append(row);
  }
  const attempt = element("attempt");
  attempt.hidden = state.attempt === null;
  attempt.textContent =
    state.attempt === null ? "" : `Attempt ${state.attempt}/${state.total}`;
  const card = element("autopsy");
  card.hidden = state.autopsy === null;
  element("ticker").hidden = state.autopsy !== null;
  if (state.autopsy) {
    const view = autopsyView(state.autopsy);
    card.dataset.status = state.autopsy.status;
    for (const key of [
      "verdict",
      "family",
      "breaker",
      "guesser",
      "patch",
      "explanation",
      "green",
      "delta",
    ] as const) {
      const item = element(`autopsy-${key}`);
      item.textContent = view[key];
      item.title = view[key];
    }
    const diff = element("autopsy-diff");
    diff.replaceChildren();
    for (const { text, source } of view.diffLines) {
      const line = document.createElement("span");
      line.textContent = text;
      line.title = source;
      line.dataset.change = text.startsWith("-")
        ? "removed"
        : text.startsWith("+")
          ? "added"
          : "context";
      diff.append(line);
    }
    const splits = element("autopsy-splits");
    splits.replaceChildren();
    for (const split of view.splits) {
      const row = document.createElement("li");
      row.textContent = split;
      splits.append(row);
    }
    element("autopsy-reason").hidden = view.reason === null;
    element("autopsy-reason").textContent = view.reason;
    element("autopsy-delta").dataset.trend = view.trend;
    const regression = element("autopsy-regression");
    regression.hidden = view.regression === null;
    regression.textContent = view.regression;
    regression.dataset.status = view.regressionStatus ?? "";
    regression.title = view.regressionDetail ?? "";
  }
}

export function renderClock(state: BroadcastState, nowMs: number): void {
  const seconds = headStartSeconds(state, nowMs);
  const active =
    seconds !== null && seconds > 0 && state.bug !== "fixed" && !state.autopsy;
  element("countdown").hidden = !active;
  element("fuse").hidden = !active;
  element("seconds").textContent = `${seconds ?? 15}s`;
  element("fuse-fill").style.width =
    `${state.headStartMs > 0 ? ((seconds ?? 0) / (state.headStartMs / 1000)) * 100 : 0}%`;
}
