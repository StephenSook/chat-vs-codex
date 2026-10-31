import { sha256, type TriageDataset } from "./dataset.js";
import type { TriagePrediction } from "./predict.js";
import type { TrainingOutput } from "./train.js";
export interface AbAssignment {
  pair: number;
  game: "platformer" | "breakout";
  mutantId: string;
  arm: "with-hint" | "without-hint";
  prediction: TriagePrediction;
}
export function planAb(
  data: TriageDataset,
  training: TrainingOutput,
  modelDigest: string,
  pairs = 30,
): {
  schemaVersion: 1;
  pairs: number;
  trials: number;
  seed: number;
  datasetDigest: string;
  schedule: AbAssignment[];
} {
  if (!Number.isSafeInteger(pairs) || pairs < 30 || pairs > data.rows.length)
    throw new Error("A/B needs at least 30 distinct paired mutants");
  if (
    new Set(data.rows.map((row) => JSON.stringify([row.game, row.mutantId])))
      .size !== data.rows.length
  )
    throw new Error("Duplicate telemetry mutant");
  if (!/^[a-f0-9]{64}$/.test(modelDigest))
    throw new Error("Invalid model digest");
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const shuffled = [...data.rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const left = shuffled[i];
    const right = shuffled[j];
    if (!left || !right) throw new Error("Invalid shuffle index");
    [shuffled[i], shuffled[j]] = [right, left];
  }
  const schedule: AbAssignment[] = [];
  for (const [pair, row] of shuffled.slice(0, pairs).entries()) {
    const fold = training.folds.find((f) => f.site === row.site);
    if (!fold || fold.trainSites.includes(row.site))
      throw new Error("A/B prediction leaks the held-out mutation region");
    const prediction = fold.predictions.find(
      (p) => p.game === row.game && p.mutantId === row.mutantId,
    );
    if (!prediction) throw new Error("Missing out-of-site A/B prediction");
    const arms = (
      random() < 0.5
        ? ["with-hint", "without-hint"]
        : ["without-hint", "with-hint"]
    ) as AbAssignment["arm"][];
    for (const arm of arms)
      schedule.push({
        pair,
        game: row.game,
        mutantId: row.mutantId,
        arm,
        prediction: {
          family: prediction.predicted,
          confidence: prediction.confidence,
          modelDigest: fold.modelDigest,
        },
      });
  }
  return {
    schemaVersion: 1,
    pairs,
    trials: pairs * 2,
    seed: 1729,
    datasetDigest: sha256(JSON.stringify(data)),
    schedule,
  };
}

/** Nothing that creates a batch or starts a runtime may precede this artifact gate. */
export async function runVerifiedAb<T>(
  verifyArtifacts: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  await verifyArtifacts();
  return run();
}
