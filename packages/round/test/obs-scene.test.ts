import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  generateObsScene,
  OBS_SCENE_PATH,
  type obsSceneCollection,
} from "../../../scripts/obs-scene.js";
import { OVERLAY_URL, ROUND_ORIGIN, ROUND_PORT } from "../src/address.js";

it("ships a fresh native OBS collection that resolves its browser source and uses the live runner address", async () => {
  await expect(generateObsScene(true)).resolves.toBe(OBS_SCENE_PATH);
  const collection = JSON.parse(
    await readFile(OBS_SCENE_PATH, "utf8"),
  ) as ReturnType<typeof obsSceneCollection>;
  expect(collection.resolution).toEqual({ x: 1920, y: 1080 });
  expect(collection.current_scene).toBe(collection.current_program_scene);
  expect(collection.scene_order).toEqual([{ name: collection.current_scene }]);
  const scene = collection.sources.find((source) => source.id === "scene");
  const browser = collection.sources.find(
    (source) => source.id === "browser_source",
  );
  expect(scene?.settings).toMatchObject({
    custom_size: true,
    cx: 1920,
    cy: 1080,
    items: [
      {
        source_uuid: browser?.uuid,
        name: browser?.name,
        visible: true,
        locked: true,
        pos: { x: 0, y: 0 },
        scale: { x: 1, y: 1 },
      },
    ],
  });
  expect(browser?.settings).toMatchObject({
    url: OVERLAY_URL,
    width: 1920,
    height: 1080,
    fps_custom: true,
    fps: 60,
    shutdown: false,
    restart_when_active: false,
  });
  const url = new URL(OVERLAY_URL);
  expect(url.origin).toBe(ROUND_ORIGIN);
  expect(Number(url.port)).toBe(ROUND_PORT);
  expect(url.searchParams.get("bridge")).toBe(ROUND_ORIGIN);
  expect(url.searchParams.has("mode")).toBe(false);
  expect(collection.sources).toHaveLength(2);
  expect(JSON.stringify(collection)).not.toMatch(
    /oauth|Bearer |stream_key|accessToken|twitch\.tv/i,
  );
});
