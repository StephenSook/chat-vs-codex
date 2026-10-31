import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { validSymptomReplay } from "../../../apps/overlay/src/symptom.js";
import { prepareWorkspace } from "../../bench/src/workspace.js";
import { FAMILIES, type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { TRACKS } from "../../replay/src/index.js";
import { captureSymptom } from "../src/symptom.js";

it.each(FAMILIES)(
  "records the actual failing %s route without revealing its family",
  async (family) => {
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find((m) => m.family === family);
    if (!mutant) throw new Error("Missing pooled family");
    const workspace = await prepareWorkspace(mutant, undefined, true);
    try {
      const replay = await captureSymptom(
        workspace.game,
        mutant,
        "a".repeat(64),
        "b".repeat(64),
      );
      expect(validSymptomReplay(replay)).toBe(true);
      expect(JSON.stringify(replay)).not.toContain(family);
      expect(Object.keys(replay)).not.toContain("family");
      const recorded = JSON.parse(
        await readFile(
          join(workspace.game, "fixtures/inspector/traces.json"),
          "utf8",
        ),
      );
      const failing = recorded.tracks.filter((_t: unknown, index: number) =>
        mutant.failedReplays.includes(TRACKS[index]?.name ?? ""),
      );
      const match = failing.find(
        (t: { buggy: { frame: number; player: { x: number; y: number } }[] }) =>
          replay.frames.every(
            (f) =>
              t.buggy[f.frame]?.player.x === f.x &&
              t.buggy[f.frame]?.player.y === f.y,
          ),
      );
      expect(match).toBeTruthy();
      expect(replay.frames[0]?.frame).toBeLessThanOrEqual(
        replay.firstDivergentFrame,
      );
      expect(replay.frames.at(-1)?.frame).toBeLessThanOrEqual(600);
      if (family === "enemy-ledge-turn") expect(replay.focus).toBe("enemy");
    } finally {
      await workspace.cleanup();
    }
  },
  30000,
);
