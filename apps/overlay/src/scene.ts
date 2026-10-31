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
import { Application, Container, Graphics } from "pixi.js";
import { RGBSplitFilter } from "pixi-filters/rgb-split";

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
export async function createScene(
  host: HTMLElement,
  experimentalFilters: boolean,
) {
  const app = new Application();
  await app.init({
    width: 1728,
    height: 518.4,
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
  world.scale.set(1728 / (WIDTH * TILE_PX));
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
  world.addChild(platform, player);

  // Never enabled by default: OBS at 4500 kbps has not been measured yet.
  const corruption = experimentalFilters
    ? new RGBSplitFilter({
        red: { x: 0, y: 0 },
        green: { x: 0, y: 0 },
        blue: { x: 0, y: 0 },
      })
    : null;
  let lastPlatformX = Number.NaN;

  return {
    app,
    draw(state: State, intensity: number) {
      player.position.set(state.x / UNIT, state.y / UNIT);
      player.alpha = state.alive ? 1 : 0.35;
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
      if (corruption) {
        corruption.red = { x: 5 * intensity, y: 0 };
        corruption.blue = { x: -5 * intensity, y: 0 };
        world.filters = intensity > 0 ? [corruption] : [];
      }
      // Application's render plugin draws after this ticker callback. Do not render twice.
    },
    destroy() {
      app.destroy(true, { children: true });
      corruption?.destroy();
    },
  };
}
