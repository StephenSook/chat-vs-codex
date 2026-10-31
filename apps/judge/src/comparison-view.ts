import type { ComparisonFrame, replayComparison } from "./comparison.js";
import type { GameModule } from "./proof.js";

type Comparison = Awaited<ReturnType<typeof replayComparison>>;
const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 180;

export interface ComparisonCamera {
  x: number;
  y: number;
  focus: "player" | "enemy";
}

/** Both panes follow one position in the fixed simulation, never separate cameras. */
export function comparisonCamera(
  game: GameModule,
  broken: ComparisonFrame,
  fixed: ComparisonFrame,
): ComparisonCamera {
  const playerDelta =
    Math.abs(broken.x - fixed.x) + Math.abs(broken.y - fixed.y);
  const enemyDelta =
    Math.abs(broken.enemy.x - fixed.enemy.x) +
    Math.abs(broken.enemy.y - fixed.enemy.y);
  const focus = enemyDelta > playerDelta ? "enemy" : "player";
  const target = focus === "enemy" ? fixed.enemy : fixed;
  return {
    x: Math.max(
      0,
      Math.min(
        (game.WIDTH * game.TILE) / game.UNIT - VIEW_WIDTH,
        (target.x + game.PLAYER_WIDTH / 2) / game.UNIT - VIEW_WIDTH / 2,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        (game.HEIGHT * game.TILE) / game.UNIT - VIEW_HEIGHT,
        (target.y + game.PLAYER_HEIGHT / 2) / game.UNIT - VIEW_HEIGHT / 2,
      ),
    ),
    focus,
  };
}

/** Draw only real tile geometry, the frame's entities, and its moving platform. */
export function drawComparisonFrame(
  context: CanvasRenderingContext2D,
  game: GameModule,
  frame: ComparisonFrame,
  camera: ComparisonCamera,
): void {
  context.setTransform(2, 0, 0, 2, 0, 0);
  context.fillStyle = "#fffdf9";
  context.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);
  for (let row = 0; row < game.HEIGHT; row++) {
    for (let column = 0; column < game.WIDTH; column++) {
      const tile = game.LEVEL[row]?.[column];
      if (tile !== "#" && tile !== "!" && tile !== "G") continue;
      context.fillStyle =
        tile === "#" ? "#1f1d1b" : tile === "!" ? "#c83d2e" : "#0477bd";
      context.fillRect(
        (column * game.TILE) / game.UNIT - camera.x,
        (row * game.TILE) / game.UNIT - camera.y,
        game.TILE / game.UNIT,
        game.TILE / game.UNIT,
      );
    }
  }
  const platform = game.platformAt(frame.frame);
  context.fillStyle = "#655b50";
  context.fillRect(
    platform.x / game.UNIT - camera.x,
    platform.y / game.UNIT - camera.y,
    platform.width / game.UNIT,
    platform.height / game.UNIT,
  );
  context.fillStyle = "#c83d2e";
  context.fillRect(
    frame.enemy.x / game.UNIT - camera.x,
    frame.enemy.y / game.UNIT - camera.y,
    game.PLAYER_WIDTH / game.UNIT,
    game.PLAYER_HEIGHT / game.UNIT,
  );
  context.fillStyle = frame.alive ? "#F7914E" : "#655b50";
  context.fillRect(
    frame.x / game.UNIT - camera.x,
    frame.y / game.UNIT - camera.y,
    game.PLAYER_WIDTH / game.UNIT,
    game.PLAYER_HEIGHT / game.UNIT,
  );
}

export function createComparisonView(): {
  element: HTMLElement;
  reset(reason?: string): void;
  show(brokenGame: GameModule, fixedGame: GameModule, result: Comparison): void;
} {
  const element = document.createElement("div");
  element.className = "comparison-view";
  element.dataset.testid = "comparison-view";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const content = document.createElement("div");
  const label = document.createElement("p");
  label.textContent = "Same replay inputs · re-simulated";
  const panes = document.createElement("div");
  panes.className = "comparison-panes";
  const canvas = (name: "BROKEN" | "FIXED") => {
    const pane = document.createElement("figure");
    const heading = document.createElement("figcaption");
    heading.textContent = name;
    const image = document.createElement("canvas");
    image.width = 640;
    image.height = 360;
    image.dataset.testid = name === "BROKEN" ? "broken-view" : "fixed-view";
    image.setAttribute("aria-label", `${name} re-simulated game`);
    pane.append(heading, image);
    panes.append(pane);
    return image;
  };
  const brokenCanvas = canvas("BROKEN");
  const fixedCanvas = canvas("FIXED");
  const controls = document.createElement("div");
  controls.className = "comparison-controls";
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Play";
  const scrubber = document.createElement("input");
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.step = "1";
  scrubber.setAttribute("aria-label", "Comparison replay frame");
  const frameLabel = document.createElement("p");
  frameLabel.dataset.testid = "comparison-frame";
  controls.append(play, scrubber, frameLabel);
  content.append(label, panes, controls);
  element.append(status, content);

  let comparison: Comparison | null = null;
  let brokenModule: GameModule | null = null;
  let fixedModule: GameModule | null = null;
  let index = 0;
  let animation: number | null = null;
  let generation = 0;
  let playing = false;
  const pause = () => {
    generation++;
    playing = false;
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
    play.textContent = "Play";
    play.setAttribute("aria-pressed", "false");
  };
  const render = () => {
    const broken = comparison?.broken[index];
    const fixed = comparison?.fixed[index];
    if (!broken || !fixed || !brokenModule || !fixedModule) return;
    const camera = comparisonCamera(fixedModule, broken, fixed);
    for (const [image, game, frame] of [
      [brokenCanvas, brokenModule, broken],
      [fixedCanvas, fixedModule, fixed],
    ] as const) {
      const context = image.getContext("2d");
      if (!context) throw new Error("Comparison canvas is unavailable");
      drawComparisonFrame(context, game, frame, camera);
      image.dataset.frame = String(frame.frame);
      image.dataset.hash = frame.stateHash;
      image.dataset.cameraX = String(camera.x);
      image.dataset.cameraY = String(camera.y);
      image.dataset.focus = camera.focus;
    }
    scrubber.value = String(index);
    frameLabel.textContent = `Frame ${fixed.frame} of ${comparison?.fixed.length}`;
    frameLabel.dataset.frame = String(fixed.frame);
  };
  play.addEventListener("click", () => {
    if (playing) {
      pause();
      return;
    }
    if (!comparison || document.visibilityState === "hidden") return;
    if (index === comparison.fixed.length - 1) index = 0;
    const startIndex = index;
    const startedAt = performance.now();
    const turn = ++generation;
    playing = true;
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    render();
    const advance = (now: number) => {
      if (turn !== generation || !playing || !comparison) return;
      index = Math.min(
        comparison.fixed.length - 1,
        startIndex + Math.floor((Math.max(0, now - startedAt) * 60) / 1000),
      );
      render();
      if (index === comparison.fixed.length - 1) pause();
      else animation = requestAnimationFrame(advance);
    };
    animation = requestAnimationFrame(advance);
  });
  scrubber.addEventListener("input", () => {
    pause();
    if (!comparison) return;
    index = Math.max(
      0,
      Math.min(comparison.fixed.length - 1, Math.round(Number(scrubber.value))),
    );
    render();
  });
  window.addEventListener("pagehide", pause);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pause();
  });
  const reset = (reason = "Choose a round to compare its original glitch.") => {
    pause();
    comparison = null;
    brokenModule = null;
    fixedModule = null;
    content.hidden = true;
    status.textContent = reason;
    frameLabel.textContent = "";
    delete frameLabel.dataset.frame;
    for (const image of [brokenCanvas, fixedCanvas]) {
      for (const key of ["frame", "hash", "cameraX", "cameraY", "focus"])
        delete image.dataset[key];
      image.getContext("2d")?.clearRect(0, 0, image.width, image.height);
    }
  };
  reset();
  return {
    element,
    reset,
    show(brokenGame, fixedGame, result) {
      reset();
      if (
        !result.fixed.length ||
        result.fixed.length !== result.broken.length ||
        result.fixed.some(
          (frame, position) =>
            frame.frame !== position + 1 ||
            result.broken[position]?.frame !== frame.frame,
        )
      )
        throw new Error("Comparison frames must be paired and sequential");
      comparison = result;
      brokenModule = brokenGame;
      fixedModule = fixedGame;
      index = Math.max(
        0,
        Math.min(
          result.fixed.length - 1,
          (result.visibleFrame ?? result.firstDivergence + 15) - 1,
        ),
      );
      scrubber.max = String(result.fixed.length - 1);
      status.textContent = "";
      content.hidden = false;
      try {
        render();
      } catch (error) {
        reset("Comparison canvas is unavailable.");
        throw error;
      }
    },
  };
}
