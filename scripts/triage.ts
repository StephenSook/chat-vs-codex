import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planAb } from "../packages/triage/src/ab.js";
import {
  featureExtractorDigest,
  sha256,
  type TriageDataset,
  writeDataset,
} from "../packages/triage/src/dataset.js";
import { verifyOnnx } from "../packages/triage/src/parity.js";
import {
  renderTriageReport,
  type TriageMetrics,
} from "../packages/triage/src/report.js";
import {
  assertEvaluationMetrics,
  assertTrainingDataset,
  evaluatorDigest,
  TRAINER,
  type TrainingOutput,
  train,
} from "../packages/triage/src/train.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = process.argv[2] ?? "--check";
const directory = join(root, "bench/triage");
const python =
  process.env.TRIAGE_PYTHON ?? join(root, ".local/triage-venv/bin/python");
if (mode === "--setup") {
  await mkdir(join(root, ".local"), { recursive: true });
  for (const [program, args] of [
    [
      process.env.TRIAGE_BOOTSTRAP_PYTHON ?? "python3.12",
      ["-m", "venv", join(root, ".local/triage-venv")],
    ],
    [
      python,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-cache-dir",
        "numpy==2.2.6",
        "protobuf==5.29.5",
        "cloudpickle==3.1.2",
        "joblib==1.6.0",
        "ml_dtypes==0.6.0",
        "scipy==1.18.1",
        "threadpoolctl==3.7.0",
        "typing_extensions==4.16.0",
        "scikit-learn==1.7.2",
        "onnx==1.19.1",
        "skl2onnx==1.20.0",
      ],
    ],
  ] as const) {
    const result = spawnSync(program, [...args], {
      stdio: "inherit",
      timeout: 180000,
    });
    if (result.error || result.status !== 0)
      throw new Error("Pinned external trainer setup failed");
  }
} else if (mode === "--record") {
  await writeDataset(root);
  await train(root, python);
} else if (!["--check", "--plan"].includes(mode))
  throw new Error("Use --setup, --record, --check or --plan");
if (mode !== "--setup") {
  const datasetText = await readFile(join(directory, "dataset.json"), "utf8");
  const data = JSON.parse(datasetText) as TriageDataset;
  const training = JSON.parse(
    await readFile(join(directory, "training.json"), "utf8"),
  ) as TrainingOutput;
  const metrics = JSON.parse(
    await readFile(join(directory, "metrics.json"), "utf8"),
  ) as TriageMetrics;
  if (data.featureExtractorDigest !== (await featureExtractorDigest()))
    throw new Error("Stale triage feature extractor; rerecord training");
  assertTrainingDataset(data, training);
  assertEvaluationMetrics(training, metrics);
  if (metrics.evaluatorDigest !== (await evaluatorDigest()))
    throw new Error("Stale TypeScript evaluator digest");
  if (metrics.datasetDigest !== sha256(JSON.stringify(data)))
    throw new Error("Triage dataset digest mismatch");
  for (const [game, path] of [
    ["platformer", "packages/mutator/pool.json"],
    ["breakout", "games/breakout/pool.json"],
  ] as const) {
    const text = await readFile(join(root, path), "utf8");
    const pool = JSON.parse(text) as {
      mutants: { id: string; family: string; file: string; site: string }[];
    };
    if (
      data.poolDigests[game] !== sha256(text) ||
      pool.mutants.length !== data.rows.filter((r) => r.game === game).length ||
      pool.mutants.some(
        (m) =>
          !data.rows.some(
            (r) =>
              r.game === game &&
              r.mutantId === m.id &&
              r.family === `${game}:${m.family}` &&
              r.site === `${game}:${m.file}:${m.site}`,
          ),
      )
    )
      throw new Error(`Stale or incomplete ${game} telemetry coverage`);
  }
  const summary = renderTriageReport(metrics);
  if (mode === "--record")
    await writeFile(join(directory, "SUMMARY.md"), summary);
  else if ((await readFile(join(directory, "SUMMARY.md"), "utf8")) !== summary)
    throw new Error("Stale triage summary");
  const parity = await verifyOnnx(directory, training, metrics.modelDigest);
  const verification = {
    schemaVersion: 1,
    modelDigest: metrics.modelDigest,
    trainerBridgeDigest: sha256(TRAINER),
    nodeRuntime: "onnxruntime-node",
    ...parity,
  };
  const parityPath = join(directory, "onnx-verification.json");
  if (mode === "--record")
    await writeFile(parityPath, `${JSON.stringify(verification, null, 2)}\n`);
  else {
    const existing = JSON.parse(await readFile(parityPath, "utf8"));
    if (
      existing.modelDigest !== verification.modelDigest ||
      existing.trainerBridgeDigest !== verification.trainerBridgeDigest
    )
      throw new Error("Stale trainer or inference verification");
  }
  if (mode === "--plan")
    console.log(
      JSON.stringify(planAb(data, training, metrics.modelDigest), null, 2),
    );
  else
    console.log(
      `Triage: ${data.rows.length} gated mutants; Node ONNX parity passed (${parity.referenceRows} reference rows across ${parity.models} models).`,
    );
}
