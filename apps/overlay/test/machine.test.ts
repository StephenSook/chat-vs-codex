import { afterEach, expect, it, vi } from "vitest";
import type {
  MachineLoad,
  RoundEnvelope,
} from "../../../packages/round/src/contracts.js";
import { parseRoundEnvelope } from "../src/bridge.js";
import { initialBroadcast, reduceBroadcast } from "../src/events.js";
import { renderBroadcast } from "../src/hud.js";

class Element {
  hidden = false;
  textContent = "";
  title = "";
  className = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  replaceChildren() {
    this.children = [];
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  setAttribute() {}
}
function dom() {
  const elements = new Map<string, Element>();
  vi.stubGlobal("document", {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() {
      return new Element();
    },
  });
  return elements;
}
const machine: MachineLoad = {
  load1m: 9,
  coreCount: 8,
  busy: true,
  atMs: 1000,
  wallTime: "2026-10-31T18:00:00.000Z",
};
afterEach(() => vi.unstubAllGlobals());
it("replaces the season during a busy active round, survives round.started and restores season on the real autopsy", () => {
  const elements = dom();
  let state = reduceBroadcast(initialBroadcast(), {
    type: "round.preparing",
    id: "round",
  });
  state = reduceBroadcast(state, {
    type: "machine.load",
    roundId: "round",
    machine,
  });
  state = reduceBroadcast(state, {
    type: "round.started",
    id: "round",
    number: 1,
    atMs: 1000,
  });
  renderBroadcast(state);
  expect(elements.get("machine-note")?.textContent).toBe(
    "Busy machine, results may be slow",
  );
  expect(elements.get("machine-note")?.hidden).toBe(false);
  expect(elements.get("season-line")?.hidden).toBe(true);
  const season = elements.get("season-line");
  if (season) season.textContent = "SEASON · CHAT 2 : CODEX 1";
  renderBroadcast(state);
  expect(season?.hidden).toBe(true);
  const autopsy: NonNullable<typeof state.autopsy> = {
    roundId: "round",
    status: "verified",
    reason: null,
    breaker: null,
    firstCorrectGuesser: null,
    family: "gravity-sign",
    winner: "codex",
    patch: null,
    explanation: "Fixed gravity sign",
    durations: {
      headStartMs: 15000,
      repairMs: 9000,
      validationMs: 2000,
      swapMs: 1,
      timeToGreenMs: 11001,
    },
    previousRoundId: null,
    deltaMs: null,
    regressionTest: null,
    regressionError: null,
  };
  state = reduceBroadcast(state, {
    type: "round.autopsy",
    roundId: "round",
    autopsy,
  });
  renderBroadcast(state);
  expect(elements.get("machine-note")?.hidden).toBe(true);
  expect(season?.hidden).toBe(false);
  if (season) season.textContent = "";
  renderBroadcast(state);
  expect(season?.hidden).toBe(true);
  state = reduceBroadcast(state, { type: "round.preparing", id: "next" });
  expect(state.machine).toBeNull();
  state = reduceBroadcast(state, {
    type: "machine.load",
    roundId: "old",
    machine,
  });
  expect(state.machine).toBeNull();
});
it("accepts genuine CPU measurements and rejects malformed sample fields across both wire paths", () => {
  const event: RoundEnvelope = {
    sequence: 1,
    serverTimeMs: 1000,
    event: { type: "round.machine", roundId: "round", machine },
  };
  expect(parseRoundEnvelope(event)).toEqual(event);
  const overlay: RoundEnvelope = {
    ...event,
    event: {
      type: "overlay",
      event: { type: "machine.load", roundId: "round", machine },
    },
  };
  expect(parseRoundEnvelope(overlay)).toEqual(overlay);
  for (const sample of [
    { ...machine, coreCount: 0 },
    { ...machine, busy: false },
    { ...machine, load1m: Number.NaN },
    { ...machine, wallTime: "bad" },
    { ...machine, username: "private" },
  ]) {
    expect(() =>
      parseRoundEnvelope({
        ...event,
        event: { ...event.event, machine: sample },
      }),
    ).toThrow("Invalid machine");
    expect(() =>
      parseRoundEnvelope({
        ...overlay,
        event: {
          type: "overlay",
          event: { type: "machine.load", roundId: "round", machine: sample },
        },
      }),
    ).toThrow("Invalid round event");
  }
});
