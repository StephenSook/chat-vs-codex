import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInspectorData } from "../../inspector-mcp/src/index.js";
import type { PooledMutant } from "../../mutator/src/gate.js";
import { TRACKS } from "../../replay/src/index.js";
import type { SymptomReplay } from "./contracts.js";

/** Reuse the bounded capture of the original planted source, never execute it again.
 * Selection is based on observable divergence; neither the family nor track name
 * is sent to the overlay before reveal. The held-out validator is separate.
 */
export async function captureSymptom(
  game: string,
  mutant: PooledMutant,
  buildDigest: string,
  sourceDigest: string,
): Promise<SymptomReplay> {
  const data = parseInspectorData(
    JSON.parse(
      await readFile(join(game, "fixtures/inspector/traces.json"), "utf8"),
    ),
  );
  for (const [index, track] of data.tracks.entries()) {
    const original = TRACKS[index];
    if (!original || !mutant.failedReplays.includes(original.name)) continue;
    // The gate's visibility frame uses its exact distance/death predicate.
    // Do not approximate it here: diagonal divergence can exceed 32 px even
    // when neither coordinate does on its own.
    const visible = mutant.evidence.find(
      (row) => row.name === original.name,
    )?.visibleFrame;
    if (visible == null || visible < 1 || visible > 600) continue;
    const first = track.buggy.findIndex(
      (frame, i) => JSON.stringify(frame) !== JSON.stringify(track.golden[i]),
    );
    const frame = track.buggy[visible];
    const golden = track.golden[visible];
    if (!frame || !golden) continue;
    const enemyMoved =
      frame.enemy.x !== golden.enemy.x || frame.enemy.y !== golden.enemy.y;
    const focus = enemyMoved ? "enemy" : "player";
    // Keep the lead-in and visible consequence, then loop this honest excerpt.
    // Even an early death is preceded by motion on every loop.
    const from = Math.max(0, first - 60);
    const died = track.buggy.findIndex(
      (sample) => sample.player.alive === false,
    );
    const to = Math.min(
      track.buggy.length,
      601,
      Math.max(visible + 61, from + 180),
      died < 0 ? 601 : died + 31,
    );
    return {
      fps: 60,
      buildDigest,
      sourceDigest,
      trackDigest: createHash("sha256")
        .update(JSON.stringify(original))
        .digest("hex"),
      firstDivergentFrame: first,
      focus,
      frames: track.buggy.slice(from, to).map((sample) => ({
        frame: sample.frame,
        x: Number(sample.player.x),
        y: Number(sample.player.y),
        vx: Number(sample.player.vx),
        vy: Number(sample.player.vy),
        alive: Boolean(sample.player.alive),
        won: Boolean(sample.player.won),
        enemy: { ...sample.enemy },
      })),
    };
  }
  throw new Error("No recorded failing replay has a visible symptom");
}
