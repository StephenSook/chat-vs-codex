import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { RoundAutopsy } from "../../../packages/round/src/contracts.js";
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
afterEach(() => vi.unstubAllGlobals());
it("renders two real model tickers, and a low-memory refusal without an activity row", () => {
  const elements = dom();
  let state = reduceBroadcast(initialBroadcast(), {
    type: "round.started",
    id: "boss",
    number: 1,
    atMs: 0,
  });
  state = reduceBroadcast(state, { type: "boss.started", roundId: "boss" });
  state = reduceBroadcast(state, {
    type: "codex.step",
    model: "terra",
    roundId: "boss",
    id: "read",
    status: "running",
    attempt: 1,
    total: 1,
    step: { kind: "reading", path: "src/index.ts" },
  });
  renderBroadcast(state);
  expect(elements.get("boss-crews")?.hidden).toBe(false);
  expect(elements.get("steps")?.hidden).toBe(true);
  expect(elements.get("boss-terra-steps")?.children[0]?.textContent).toBe(
    "◌ Reading index.ts",
  );
  expect(elements.get("boss-sol-steps")?.children).toEqual([]);
  renderBroadcast(
    reduceBroadcast(initialBroadcast(), {
      type: "boss.note",
      text: "BOSS PAUSED · LOW MEMORY",
    }),
  );
  expect(elements.get("boss-note")?.hidden).toBe(false);
  expect(elements.get("boss-note")?.textContent).toBe(
    "BOSS PAUSED · LOW MEMORY",
  );
});
it("puts the real losing diff below the winner diff and labels both models", () => {
  const elements = dom();
  const patch = {
    added: 1,
    removed: 1,
    preview: ["- velocity -= gravity;", "+ velocity += gravity;"],
  };
  const card: RoundAutopsy = {
    roundId: "boss",
    input: "chat",
    status: "verified",
    reason: null,
    breaker: null,
    firstCorrectGuesser: null,
    family: "gravity-sign",
    winner: "codex",
    patch,
    explanation: "Fixed sign",
    durations: {
      headStartMs: 15000,
      repairMs: 9000,
      validationMs: 1000,
      swapMs: 1,
      timeToGreenMs: 10001,
    },
    previousRoundId: null,
    deltaMs: null,
    regressionTest: null,
    regressionError: null,
    boss: {
      winner: "terra",
      memory: {
        freeBytes: 2e9,
        rssBytes: 1e8,
        minimumFreeBytes: 1e9,
        measuredAtMs: 1,
      },
      threads: [
        {
          model: "terra",
          status: "validated",
          timings: {},
          patch,
          failure: null,
        },
        {
          model: "sol",
          status: "failed",
          timings: {},
          patch,
          failure: "repair-failed",
        },
      ],
    },
  };
  renderBroadcast({ ...initialBroadcast(), roundId: "boss", autopsy: card });
  expect(elements.get("boss-winner")?.textContent).toBe("TERRA WINS");
  expect(elements.get("boss-loser-label")?.textContent).toBe("SOL · FAILED");
  expect(elements.get("boss-loser-diff")?.children).toHaveLength(2);
  expect(elements.get("boss-loser-diff")?.children[0]?.title).toBe(
    patch.preview[0],
  );
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html.indexOf('id="boss-loser"')).toBeGreaterThan(
    html.indexOf('id="autopsy-diff"'),
  );
});
