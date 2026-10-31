import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInspectorData } from "../../inspector-mcp/src/index.js";
import { replayFeatures } from "./features.js";
import { loadPredictor, type TriagePrediction } from "./predict.js";
export async function predictWorkspace(
  workspace: string,
  modelDirectory: string,
): Promise<TriagePrediction> {
  const data = parseInspectorData(
    JSON.parse(
      await readFile(join(workspace, "fixtures/inspector/traces.json"), "utf8"),
    ),
  );
  const features = replayFeatures(
    data.tracks.map((t) =>
      t.buggy.map((f) => ({
        frame: f.frame,
        input: f.input,
        x: Number(f.player.x),
        y: Number(f.player.y),
        vx: Number(f.player.vx),
        vy: Number(f.player.vy),
        alive: Boolean(f.player.alive),
        contact: Boolean(f.player.grounded),
        enemyTurns: f.enemy.turns,
      })),
    ),
  );
  const predictor = await loadPredictor(modelDirectory);
  try {
    return await predictor.predict(features);
  } finally {
    await predictor.close();
  }
}
