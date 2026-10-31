import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { sha256 } from "./dataset.js";
import { FEATURE_NAMES } from "./features.js";
import type { TrainingOutput } from "./train.js";
/** Compare every probability and label, including every held-out fold's export. */
export async function verifyOnnx(
  directory: string,
  training: TrainingOutput,
  modelDigest: string,
): Promise<{
  maximumProbabilityError: number;
  referenceRows: number;
  models: number;
}> {
  let maximumProbabilityError = 0;
  let referenceRows = 0;
  let models = 0;
  const exports = [
    {
      file: "model.onnx",
      modelDigest,
      classes: training.classes,
      reference: training.reference,
    },
    ...training.folds,
  ];
  for (const entry of exports) {
    if (
      !entry.file ||
      !/^model\.onnx$|^fold-[a-f0-9]{12}\.onnx$/.test(entry.file) ||
      !entry.classes?.length ||
      !entry.reference?.features.length
    )
      throw new Error("Missing ONNX parity evidence");
    const bytes = await readFile(join(directory, entry.file));
    if (sha256(bytes) !== entry.modelDigest)
      throw new Error("ONNX export digest mismatch");
    const session = await InferenceSession.create(bytes, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionProviders: ["cpu"],
    });
    try {
      for (const [i, features] of entry.reference.features.entries()) {
        if (
          features.length !== FEATURE_NAMES.length ||
          !features.every(Number.isFinite)
        )
          throw new Error("Invalid reference feature vector");
        const output = await session.run({
          telemetry: new Tensor("float32", Float32Array.from(features), [
            1,
            features.length,
          ]),
        });
        const expected = entry.reference.probabilities[i];
        const probabilities = output.probabilities;
        if (
          !expected ||
          !probabilities ||
          expected.length !== probabilities.data.length ||
          expected.length !== entry.classes.length
        )
          throw new Error("ONNX probability vector mismatch");
        for (const [j, score] of expected.entries()) {
          const actual = Number(probabilities.data[j]);
          if (!Number.isFinite(actual))
            throw new Error("Nonfinite ONNX probability");
          maximumProbabilityError = Math.max(
            maximumProbabilityError,
            Math.abs(actual - score),
          );
        }
        if (
          String(output.label?.data[0]) !== entry.reference.predictions[i] ||
          maximumProbabilityError > 1e-5
        )
          throw new Error("Node ONNX output differs from scikit-learn");
        referenceRows++;
      }
    } finally {
      await session.release();
    }
    models++;
  }
  return { maximumProbabilityError, referenceRows, models };
}
