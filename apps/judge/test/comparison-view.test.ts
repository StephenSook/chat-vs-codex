import { afterEach, describe, expect, it, vi } from "vitest";
import * as game from "../../../packages/sim/src/index.js";
import type { ComparisonFrame } from "../src/comparison.js";
import {
  comparisonCamera,
  createComparisonView,
  drawComparisonFrame,
} from "../src/comparison-view.js";

class Context {
  fillStyle = "";
  fills: { color: string; rect: number[] }[] = [];
  transform: number[] = [];
  clears = 0;
  setTransform(...matrix: number[]) {
    this.transform = matrix;
  }
  fillRect(...rect: number[]) {
    this.fills.push({ color: this.fillStyle, rect });
  }
  clearRect() {
    this.clears++;
  }
}

/** Minimal browser wire fake: geometry still comes from the real simulation. */
class Node extends EventTarget {
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Node[] = [];
  className = "";
  textContent = "";
  hidden = false;
  width = 0;
  height = 0;
  min = "";
  max = "";
  step = "";
  type = "";
  value = "";
  context = new Context();
  constructor(readonly tag: string) {
    super();
  }
  append(...children: Node[]) {
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  getContext() {
    return this.context;
  }
}

function setup() {
  const nodes: Node[] = [];
  const document = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement(tag: string) {
      const node = new Node(tag);
      nodes.push(node);
      return node;
    },
  });
  const window = new EventTarget();
  const callbacks = new Map<number, FrameRequestCallback>();
  const canceled = new Set<number>();
  let nextId = 0;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("performance", { now: () => 0 });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    canceled.add(id);
    callbacks.delete(id);
  });
  const view = createComparisonView();
  const byId = (id: string) => {
    const node = nodes.find((candidate) => candidate.dataset.testid === id);
    if (!node) throw new Error(`Missing fake element ${id}`);
    return node;
  };
  const button = nodes.find((node) => node.tag === "button");
  const slider = nodes.find((node) => node.tag === "input");
  if (!button || !slider) throw new Error("Missing replay controls");
  return {
    view,
    nodes,
    byId,
    button,
    slider,
    callbacks,
    canceled,
    document,
    window,
  };
}

function simulate(input: number, count: number): ComparisonFrame[] {
  let state = game.createState(17);
  return Array.from({ length: count }, () => {
    state = game.step(state, input);
    return {
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
      stateHash: game.hashState(state),
      enemy: { ...state.enemy },
    };
  });
}

// Distinct real runs exercise presentation geometry. Artifact verification is
// covered by replayComparison's own producer-bound tests, not this browser fake.
function comparison(count = 90) {
  const broken = simulate(game.INPUT.LEFT, count);
  const fixed = simulate(game.INPUT.RIGHT, count);
  return {
    broken,
    fixed,
    firstDivergence:
      fixed.find((frame, index) => frame.stateHash !== broken[index]?.stateHash)
        ?.frame ?? 1,
    trackDigest: "",
    brokenFramesDigest: "",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("BROKEN / FIXED comparison presentation", () => {
  it("draws the real divergent positions with one fixed-state camera at 2x", () => {
    const result = comparison();
    const broken = result.broken[30];
    const fixed = result.fixed[30];
    if (!broken || !fixed) throw new Error("Missing real simulation frame");
    const camera = comparisonCamera(game, broken, fixed);
    expect(camera.focus).toBe("player");
    const left = new Context();
    const right = new Context();
    drawComparisonFrame(
      left as unknown as CanvasRenderingContext2D,
      game,
      broken,
      camera,
    );
    drawComparisonFrame(
      right as unknown as CanvasRenderingContext2D,
      game,
      fixed,
      camera,
    );
    expect(left.transform).toEqual([2, 0, 0, 2, 0, 0]);
    expect(right.transform).toEqual(left.transform);
    expect(left.fills.at(-1)?.rect).toEqual([
      broken.x / game.UNIT - camera.x,
      broken.y / game.UNIT - camera.y,
      game.PLAYER_WIDTH / game.UNIT,
      game.PLAYER_HEIGHT / game.UNIT,
    ]);
    expect(right.fills.at(-1)?.rect[0]).not.toBe(left.fills.at(-1)?.rect[0]);
    expect(right.fills.at(-1)?.rect[0]).toBe(fixed.x / game.UNIT - camera.x);
    expect(left.fills.at(-2)?.rect[0]).toBe(
      broken.enemy.x / game.UNIT - camera.x,
    );
    expect(right.fills.at(-3)?.rect[0]).toBe(
      game.platformAt(fixed.frame).x / game.UNIT - camera.x,
    );
  });

  it("focuses actual enemy divergence and clamps the shared camera to the map", () => {
    const fixed = simulate(0, 200).at(-1);
    const earlierEnemy = simulate(0, 1)[0]?.enemy;
    if (!fixed || !earlierEnemy) throw new Error("Missing actual enemy frames");
    const broken = { ...fixed, enemy: earlierEnemy };
    const camera = comparisonCamera(game, broken, fixed);
    expect(camera.focus).toBe("enemy");
    expect(camera.x).toBe(
      (fixed.enemy.x + game.PLAYER_WIDTH / 2) / game.UNIT - 160,
    );
    expect(camera.x).toBeGreaterThanOrEqual(0);
    expect(camera.x).toBeLessThanOrEqual(game.WIDTH * 32 - 320);
    expect(camera.y).toBeGreaterThanOrEqual(0);
    expect(camera.y).toBeLessThanOrEqual(game.HEIGHT * 32 - 180);
  });

  it("starts near the real divergence and exposes each selected frame's hashes", () => {
    const { view, byId, slider } = setup();
    const result = comparison();
    view.show(game, game, result);
    const index = result.firstDivergence - 1 + 15;
    expect(byId("comparison-frame").textContent).toBe(
      `Frame ${index + 1} of 90`,
    );
    expect(byId("broken-view").dataset.hash).toBe(
      result.broken[index]?.stateHash,
    );
    expect(byId("fixed-view").dataset.hash).toBe(
      result.fixed[index]?.stateHash,
    );
    slider.value = "30";
    slider.dispatchEvent(new Event("input"));
    expect(byId("comparison-frame").textContent).toBe("Frame 31 of 90");
    expect(byId("broken-view").dataset.cameraX).toBe(
      byId("fixed-view").dataset.cameraX,
    );
    expect(byId("broken-view").dataset.cameraY).toBe(
      byId("fixed-view").dataset.cameraY,
    );
  });

  it("opens at the verified visible frame rather than the first hash difference", () => {
    const { view, byId } = setup();
    const result = { ...comparison(), visibleFrame: 40 };
    view.show(game, game, result);
    expect(byId("comparison-frame").dataset.frame).toBe("40");
    expect(byId("broken-view").dataset.hash).toBe(result.broken[39]?.stateHash);
    expect(byId("fixed-view").dataset.hash).toBe(result.fixed[39]?.stateHash);
  });

  it("plays exact 60 Hz indices, never interpolated positions, and pauses", () => {
    const { view, byId, slider, button, callbacks } = setup();
    const result = comparison();
    view.show(game, game, result);
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    button.dispatchEvent(new Event("click"));
    const first = [...callbacks.entries()][0];
    if (!first) throw new Error("No playback frame scheduled");
    callbacks.delete(first[0]);
    first[1](1000 / 60 + 0.001);
    expect(byId("comparison-frame").dataset.frame).toBe("2");
    expect(byId("fixed-view").dataset.hash).toBe(result.fixed[1]?.stateHash);
    button.dispatchEvent(new Event("click"));
    expect(button.textContent).toBe("Play");
    expect(callbacks.size).toBe(0);
  });

  it.each(["reset", "pagehide", "hidden", "new-show"])(
    "stops playback on %s and ignores an already queued late callback",
    (stop) => {
      const { view, byId, button, callbacks, canceled, document, window } =
        setup();
      view.show(game, game, comparison());
      button.dispatchEvent(new Event("click"));
      const scheduled = [...callbacks.entries()][0];
      if (!scheduled) throw new Error("No scheduled playback");
      if (stop === "reset") view.reset("No recorded comparison.");
      if (stop === "pagehide") window.dispatchEvent(new Event("pagehide"));
      if (stop === "hidden") {
        document.visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      }
      if (stop === "new-show") view.show(game, game, comparison(20));
      const frame = byId("comparison-frame").textContent;
      const hash = byId("fixed-view").dataset.hash;
      scheduled[1](100000);
      expect(canceled.has(scheduled[0])).toBe(true);
      expect(callbacks.size).toBe(0);
      expect(byId("comparison-frame").textContent).toBe(frame);
      expect(byId("fixed-view").dataset.hash).toBe(hash);
      expect(button.textContent).toBe("Play");
      if (stop === "reset") {
        expect(byId("comparison-view").children[1]?.hidden).toBe(true);
        expect(hash).toBeUndefined();
      }
    },
  );

  it("clamps a short recording and refuses mismatched pairs without stale pixels", () => {
    const { view, byId } = setup();
    view.show(game, game, comparison(5));
    expect(byId("comparison-frame").textContent).toBe("Frame 5 of 5");
    const mismatch = comparison(5);
    mismatch.broken.pop();
    expect(() => view.show(game, game, mismatch)).toThrow("paired");
    expect(byId("comparison-view").children[1]?.hidden).toBe(true);
    expect(byId("fixed-view").dataset.hash).toBeUndefined();
  });
});
