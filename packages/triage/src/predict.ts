import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import {
  featureExtractorDigest,
  sha256,
  type TriageDataset,
} from "./dataset.js";
import { FEATURE_NAMES } from "./features.js";
export interface TriagePrediction {
  family: string;
  confidence: number;
  modelDigest: string;
}
export async function loadPredictor(directory: string): Promise<{
  predict(features: readonly number[]): Promise<TriagePrediction>;
  close(): Promise<void>;
}> {
  const model = await readFile(join(directory, "model.onnx"));
  const metadata = JSON.parse(
    await readFile(join(directory, "training.json"), "utf8"),
  ) as { classes: string[] };
  const metrics = JSON.parse(
    await readFile(join(directory, "metrics.json"), "utf8"),
  ) as { modelDigest: string; datasetDigest: string };
  const dataset = JSON.parse(
    await readFile(join(directory, "dataset.json"), "utf8"),
  ) as TriageDataset;
  if (metrics.datasetDigest !== sha256(JSON.stringify(dataset)))
    throw new Error("Triage dataset digest mismatch");
  if (
    dataset.featureExtractorDigest !== (await featureExtractorDigest()) ||
    JSON.stringify(dataset.features) !== JSON.stringify(FEATURE_NAMES)
  )
    throw new Error("Stale triage feature extractor; rerecord training");
  const modelDigest = sha256(model);
  if (metrics.modelDigest !== modelDigest || !metadata.classes.length)
    throw new Error("Triage model digest or classes mismatch");
  const session = await InferenceSession.create(model, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionProviders: ["cpu"],
  });
  return {
    async predict(features) {
      if (
        features.length !== FEATURE_NAMES.length ||
        !features.every(Number.isFinite)
      )
        throw new Error("Invalid triage feature vector");
      const output = await session.run({
        telemetry: new Tensor("float32", Float32Array.from(features), [
          1,
          features.length,
        ]),
      });
      const probabilities = output.probabilities;
      if (
        !probabilities ||
        probabilities.data.length !== metadata.classes.length
      )
        throw new Error("Invalid ONNX classifier output");
      const scores = Array.from(
        { length: probabilities.data.length },
        (_, index) => Number(probabilities.data[index]),
      );
      const confidence = Math.max(...scores);
      const family = metadata.classes[scores.indexOf(confidence)];
      if (
        !family ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1
      )
        throw new Error("Invalid triage score");
      return { family, confidence, modelDigest };
    },
    async close() {
      await session.release();
    },
  };
}
