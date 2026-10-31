import {
  HEIGHT,
  LEVEL,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  platformAt,
  type State,
  TILE,
  UNIT,
  WIDTH,
} from "@chat-vs-codex/sim";
import { Application, Container, Graphics, Text } from "pixi.js";
import { RGBSplitFilter } from "pixi-filters/rgb-split";
import type { GhostView } from "./ghost.js";
import {
  actorPositions,
  type CameraMode,
  type corruptionFor,
  playfieldCamera,
  VIEWPORT,
} from "./presentation.js";

const INK = 0x1f1d1b;
const TILE_PX = TILE / UNIT;

function clayBox(
  g: Graphics,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number,
  radius = 4,
): void {
  g.roundRect(x, y + 4, width, height, radius).fill(INK);
  g.roundRect(x, y, width, height, radius)
    .fill(fill)
    .stroke({ color: INK, width: 2 });
}

/** Art is original vector geometry, positioned from the sim's immutable world. */
export async function createScene(host: HTMLElement, cameraMode: CameraMode) {
  const app = new Application();
  await app.init({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    resolution: 1,
    antialias: true,
    backgroundAlpha: 0,
    preference: "webgl",
    autoStart: false,
  });
  host.appendChild(app.canvas);
  app.canvas.setAttribute("aria-label", "Shared simulation game canvas");
  app.canvas.setAttribute("aria-describedby", "keyboard-help");
  app.canvas.setAttribute("tabindex", "0");

  const world = new Container();
  app.stage.addChild(world);
  const background = new Graphics();
  background.rect(0, 0, WIDTH * TILE_PX, HEIGHT * TILE_PX).fill(0xd9e6df);
  // Clouds and cut-paper hills do not change collision geometry.
  for (const [x, y, width] of [
    [80, 92, 150],
    [590, 66, 180],
    [1000, 122, 140],
  ]) {
    if (x === undefined || y === undefined || width === undefined) continue;
    background.roundRect(x, y, width, 22, 11).fill(0xfaf6e9);
    background.roundRect(x + 26, y - 14, width - 70, 25, 13).fill(0xfaf6e9);
  }
  background
    .poly([0, 320, 0, 262, 140, 210, 335, 302, 520, 224, 790, 320])
    .fill(0xb7cbb9);
  background
    .poly([500, 320, 790, 233, 1010, 275, 1180, 207, 1280, 250, 1280, 320])
    .fill(0xc6d6c0);
  world.addChild(background);

  const terrain = new Graphics();
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const tile = LEVEL[row]?.[column];
      const x = column * TILE_PX;
      const y = row * TILE_PX;
      if (tile === "#") {
        clayBox(terrain, x + 1, y + 1, TILE_PX - 2, TILE_PX - 3, 0x527568, 3);
        terrain
          .moveTo(x + 7, y + 6)
          .lineTo(x + 25, y + 6)
          .stroke({ color: 0x9bb29a, width: 3 });
      } else if (tile === "!") {
        terrain
          .poly([
            x + 1,
            y + TILE_PX,
            x + 8,
            y + 3,
            x + 16,
            y + TILE_PX,
            x + 24,
            y + 3,
            x + 31,
            y + TILE_PX,
          ])
          .fill(0xe5644d)
          .stroke({ color: INK, width: 2 });
      } else if (tile === "G") {
        terrain
          .moveTo(x + 9, y + TILE_PX)
          .lineTo(x + 9, y - 34)
          .stroke({ color: INK, width: 4 });
        terrain
          .poly([
            x + 10,
            y - 34,
            x + 47,
            y - 34,
            x + 39,
            y - 19,
            x + 10,
            y - 19,
          ])
          .fill(0xf5c710)
          .stroke({ color: INK, width: 2 });
        terrain
          .moveTo(x + 20, y - 33)
          .lineTo(x + 20, y - 20)
          .moveTo(x + 30, y - 33)
          .lineTo(x + 30, y - 20)
          .stroke({ color: INK, width: 3 });
      }
    }
  }
  world.addChild(terrain);
  const platform = new Graphics();
  const player = new Graphics();
  const pw = PLAYER_WIDTH / UNIT;
  const ph = PLAYER_HEIGHT / UNIT;
  clayBox(player, 0, 0, pw, ph, 0xf7914e, 5);
  player
    .roundRect(3, 4, pw - 6, 10, 3)
    .fill(0xfffdf9)
    .stroke({ color: INK, width: 1.5 });
  player.rect(7, 7, 2, 4).rect(13, 7, 2, 4).fill(INK);
  const enemy = new Graphics();
  clayBox(enemy, 0, 0, pw, ph, 0xb16eaa, 4);
  enemy.roundRect(3, 7, pw - 6, 7, 2).fill(0xfffdf9);
  enemy.rect(6, 8, 3, 4).rect(12, 8, 3, 4).fill(INK);
  enemy
    .moveTo(2, 4)
    .lineTo(8, 7)
    .moveTo(12, 7)
    .lineTo(18, 4)
    .stroke({ color: INK, width: 2 });
  world.addChild(platform, enemy, player);

  const corruption = new RGBSplitFilter({
    red: { x: 0, y: 0 },
    green: { x: 0, y: 0 },
    blue: { x: 0, y: 0 },
  });
  const scanBands = new Graphics();
  app.stage.addChild(scanBands);
  // This fixed overview makes the recorded route visible even when the live
  // player-follow camera is somewhere else. It does not move or reset the player.
  const replayInset = new Container();
  replayInset.position.set(704, 16);
  replayInset.addChild(
    new Graphics()
      .roundRect(0, 0, 480, 180, 8)
      .fill(0xfaf6e9)
      .stroke({ color: INK, width: 3 }),
  );
  const replayLabel = new Text({
    text: "RECORDED VALIDATED REPLAY",
    style: { fontFamily: "Plus Jakarta Sans", fontSize: 20, fill: INK },
  });
  replayLabel.position.set(12, 8);
  replayInset.addChild(replayLabel);
  const replayWorld = new Container();
  replayWorld.position.set(10, 34);
  replayWorld.scale.set(460 / (WIDTH * TILE_PX));
  const replayTrail = new Graphics();
  const replayPlayer = new Graphics();
  replayPlayer
    .roundRect(0, 0, pw, ph, 4)
    .fill({ color: 0x0477bd, alpha: 0.55 })
    .stroke({ color: 0xffffff, width: 3 });
  replayWorld.addChild(
    background.clone(),
    terrain.clone(),
    replayTrail,
    replayPlayer,
  );
  replayInset.addChild(replayWorld);
  app.stage.addChild(replayInset);
  replayInset.visible = false;
  const liveGhost = replayPlayer.clone();
  world.addChild(liveGhost);
  liveGhost.visible = false;
  let lastReplay: GhostView["replay"] | null = null;
  let lastReplayIndex = -1;
  let lastTreatment = "";
  let lastPlatformX = Number.NaN;

  return {
    app,
    draw(
      state: State,
      effect: ReturnType<typeof corruptionFor>,
      ghost: GhostView | null = null,
      validating = false,
    ) {
      const camera = playfieldCamera(state, cameraMode, ghost, validating);
      world.scale.set(camera.zoom);
      world.position.set(camera.left, camera.top);
      const actors = actorPositions(state);
      player.position.set(actors.player.x, actors.player.y);
      enemy.position.set(actors.enemy.x, actors.enemy.y);
      player.alpha = state.alive ? 1 : 0.35;
      replayInset.visible = ghost !== null;
      liveGhost.visible = ghost !== null;
      if (ghost) {
        const sample = ghost.replay.frames[ghost.index];
        if (sample) {
          replayPlayer.position.set(sample.x / UNIT, sample.y / UNIT);
          liveGhost.position.copyFrom(replayPlayer.position);
          liveGhost.alpha = sample.alive ? 0.7 : 0.3;
          replayLabel.text = ghost.reducedMotion
            ? "RECORDED VALIDATED ROUTE"
            : "RECORDED VALIDATED REPLAY";
          if (lastReplay !== ghost.replay || lastReplayIndex !== ghost.index) {
            replayTrail.clear();
            for (const [index, frame] of ghost.replay.frames.entries()) {
              if (index > ghost.index) break;
              const x = frame.x / UNIT + pw / 2;
              const y = frame.y / UNIT + ph / 2;
              if (index === 0) replayTrail.moveTo(x, y);
              else replayTrail.lineTo(x, y);
            }
            replayTrail.stroke({ color: 0x0477bd, alpha: 0.55, width: 5 });
            lastReplay = ghost.replay;
            lastReplayIndex = ghost.index;
          }
        }
      }
      const rect = platformAt(state.frame);
      if (rect.x !== lastPlatformX) {
        platform.clear();
        clayBox(
          platform,
          rect.x / UNIT,
          rect.y / UNIT,
          rect.width / UNIT,
          rect.height / UNIT,
          0x0477bd,
        );
        lastPlatformX = rect.x;
      }
      corruption.red = { x: effect.rgbOffset, y: 0 };
      corruption.blue = { x: -effect.rgbOffset, y: 0 };
      world.filters = effect.rgbOffset > 0 ? [corruption] : [];
      const treatment = `${effect.treatment}:${effect.intensity}:${effect.band}`;
      if (treatment !== lastTreatment) {
        scanBands.clear();
        if (effect.intensity > 0) {
          // Sparse translucent bands keep the player's route visible. Reduced motion
          // retains the same static color treatment without shifts or animation.
          for (let y = 12; y < VIEWPORT.height; y += 28) {
            scanBands
              .rect(0, y, VIEWPORT.width, 2)
              .fill({ color: 0xe5644d, alpha: effect.intensity * 0.18 });
          }
          const bandY = 48 + effect.band * 56;
          scanBands
            .rect(0, bandY, VIEWPORT.width, 9)
            .fill({ color: 0x0477bd, alpha: effect.intensity * 0.24 });
          scanBands
            .rect(8, bandY + 9, VIEWPORT.width - 8, 4)
            .fill({ color: 0xe5644d, alpha: effect.intensity * 0.5 });
          scanBands
            .rect(0, 0, 7, VIEWPORT.height)
            .fill({ color: 0xe5644d, alpha: effect.intensity });
          scanBands
            .rect(VIEWPORT.width - 7, 0, 7, VIEWPORT.height)
            .fill({ color: 0x0477bd, alpha: effect.intensity });
        }
        lastTreatment = treatment;
      }
      // Application's render plugin draws after this ticker callback. Do not render twice.
    },
    destroy() {
      app.destroy(true, { children: true });
      corruption.destroy();
    },
  };
}
