import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_URL } from "../packages/round/src/address.js";

export const OBS_SCENE_PATH = fileURLToPath(
  new URL("../obs/chat-vs-codex.scene.json", import.meta.url),
);

/** OBS native source serialization, with no account, service or stream credentials.
 * https://github.com/obsproject/obs-studio/blob/master/frontend/widgets/OBSBasic_SceneCollections.cpp
 * https://github.com/obsproject/obs-studio/blob/master/libobs/obs-scene.c
 * https://github.com/obsproject/obs-browser/blob/master/obs-browser-source.cpp
 * Output resolution and fps are PROFILE settings, set separately in OBS Settings > Video.
 */
export function obsSceneCollection() {
  const sceneName = "Chat vs Codex";
  const browserName = "Chat vs Codex Game";
  const browserUuid = "3c03c6b0-5383-4c49-bb1d-ecf9d6ac56d0";
  return {
    name: sceneName,
    current_scene: sceneName,
    current_program_scene: sceneName,
    scene_order: [{ name: sceneName }],
    resolution: { x: 1920, y: 1080 },
    sources: [
      {
        name: browserName,
        uuid: browserUuid,
        id: "browser_source",
        versioned_id: "browser_source",
        settings: {
          url: OVERLAY_URL,
          is_local_file: false,
          width: 1920,
          height: 1080,
          fps_custom: true,
          fps: 60,
          shutdown: false,
          restart_when_active: false,
          reroute_audio: false,
        },
        enabled: true,
        muted: false,
        volume: 1,
        hotkeys: {},
      },
      {
        name: sceneName,
        uuid: "adc07073-e3ec-4b84-a4dd-731df66dc9c8",
        id: "scene",
        versioned_id: "scene",
        settings: {
          custom_size: true,
          cx: 1920,
          cy: 1080,
          id_counter: 1,
          items: [
            {
              name: browserName,
              source_uuid: browserUuid,
              id: 1,
              visible: true,
              locked: true,
              pos: { x: 0, y: 0 },
              rot: 0,
              scale: { x: 1, y: 1 },
              align: 5,
              bounds_type: 0,
              bounds_align: 0,
              bounds: { x: 0, y: 0 },
              crop_left: 0,
              crop_right: 0,
              crop_top: 0,
              crop_bottom: 0,
            },
          ],
        },
        enabled: true,
        hotkeys: {},
      },
    ],
    groups: [],
    transitions: [],
    quick_transitions: [],
    saved_projectors: [],
    modules: {},
  };
}

export async function generateObsScene(check = false) {
  const collection = obsSceneCollection();
  if (check) {
    const actual: unknown = JSON.parse(await readFile(OBS_SCENE_PATH, "utf8"));
    if (JSON.stringify(actual) !== JSON.stringify(collection))
      throw new Error("OBS scene collection is stale. Run pnpm obs:scene.");
  } else {
    await mkdir(dirname(OBS_SCENE_PATH), { recursive: true });
    await writeFile(OBS_SCENE_PATH, `${JSON.stringify(collection, null, 2)}\n`);
  }
  return OBS_SCENE_PATH;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Use pnpm obs:scene [--check]");
  console.log(await generateObsScene(args.includes("--check")));
}
