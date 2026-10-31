import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, type TriageDataset } from "./dataset.js";
import { FEATURE_NAMES } from "./features.js";
/** Training is the real external scikit-learn implementation, invoked by TypeScript.
 * The generated Python bridge is local tooling, not a second application runtime. */
export const TRAINER = String.raw`
import json, sys, hashlib, importlib.metadata, numpy as np, sklearn, skl2onnx, onnx
from sklearn.ensemble import HistGradientBoostingClassifier
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
from pathlib import Path
source=Path(sys.argv[1]); target=Path(sys.argv[2]); data=json.loads(source.read_text())
X=np.asarray([r['features'] for r in data['rows']], dtype=np.float32)
y=np.asarray([r['family'] for r in data['rows']]); sites=sorted(set(r['site'] for r in data['rows']))
def model(): return HistGradientBoostingClassifier(max_iter=40,max_leaf_nodes=7,min_samples_leaf=2,random_state=1729,early_stopping=False)
def export_model(clf, filename):
 export=convert_sklearn(clf,name='chat-vs-codex-triage',initial_types=[('telemetry',FloatTensorType([None,X.shape[1]]))],options={id(clf):{'zipmap':False}},target_opset={'':17,'ai.onnx.ml':3})
 onnx.checker.check_model(export); blob=export.SerializeToString(); (target/filename).write_bytes(blob); return hashlib.sha256(blob).hexdigest()
folds=[]
for site in sites:
 test=np.asarray([r['site']==site for r in data['rows']]); clf=model().fit(X[~test],y[~test]); probabilities=clf.predict_proba(X[test]); predicted=clf.predict(X[test]); indices=np.flatnonzero(test)
 fold_file='fold-'+hashlib.sha256(site.encode()).hexdigest()[:12]+'.onnx'; fold_digest=export_model(clf,fold_file)
 folds.append({'file':fold_file,'classes':list(clf.classes_),'reference':{'features':X[test].tolist(),'probabilities':probabilities.tolist(),'predictions':predicted.tolist()},'modelDigest':fold_digest,'site':site,'trainSites':[s for s in sites if s!=site],'unseenLabels':sorted(set(y[test])-set(y[~test])),'predictions':[{'mutantId':data['rows'][int(i)]['mutantId'],'game':data['rows'][int(i)]['game'],'actual':str(y[i]),'predicted':str(p),'confidence':float(np.max(probabilities[j]))} for j,(i,p) in enumerate(zip(indices,predicted))]})
clf=model().fit(X,y)
export_model(clf,'model.onnx')
(target/'training.json').write_text(json.dumps({'trainer':'sklearn.ensemble.HistGradientBoostingClassifier','versions':{'python':sys.version,**{name:importlib.metadata.version(name) for name in ['numpy','scikit-learn','onnx','skl2onnx','protobuf','cloudpickle','joblib','ml_dtypes','scipy','threadpoolctl','typing_extensions']}},'seed':1729,'parameters':clf.get_params(),'classes':list(clf.classes_),'folds':folds,'reference':{'features':X.tolist(),'probabilities':clf.predict_proba(X).tolist(),'predictions':clf.predict(X).tolist()}},sort_keys=True,indent=2)+'\n')
`;
export interface FoldPrediction {
  mutantId: string;
  game: "platformer" | "breakout";
  actual: string;
  predicted: string;
  confidence: number;
}
export interface TrainingOutput {
  trainer: string;
  versions: Record<string, string>;
  classes: string[];
  folds: {
    file?: string;
    classes?: string[];
    reference?: TrainingOutput["reference"];
    modelDigest: string;
    site: string;
    trainSites: string[];
    unseenLabels: string[];
    predictions: FoldPrediction[];
  }[];
  reference: {
    features: number[][];
    probabilities: number[][];
    predictions: string[];
  };
}
/** Bootstrap whole held-out sites, preserving within-site correlation. */
export function accuracySummary(output: TrainingOutput): {
  n: number;
  sites: number;
  accuracy: number;
  bootstrap95: [number, number];
  unseenLabelExamples: number;
} {
  const folds = output.folds;
  if (
    !folds.length ||
    folds.some((f) => !f.predictions.length || f.trainSites.includes(f.site))
  )
    throw new Error("Invalid disjoint site holdout");
  const score = (selected: typeof folds) => {
    const rows = selected.flatMap((f) => f.predictions);
    return rows.filter((p) => p.actual === p.predicted).length / rows.length;
  };
  let seed = 1729;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const boot = Array.from({ length: 2000 }, () =>
    score(
      folds
        .map(() => folds[Math.floor(random() * folds.length)] ?? folds[0])
        .filter((f): f is (typeof folds)[number] => f !== undefined),
    ),
  ).sort((a, b) => a - b);
  return {
    n: folds.reduce((n, f) => n + f.predictions.length, 0),
    sites: folds.length,
    accuracy: score(folds),
    bootstrap95: [boot[49] ?? 0, boot[1949] ?? 0],
    unseenLabelExamples: folds.reduce(
      (n, f) =>
        n +
        f.predictions.filter((p) => f.unseenLabels.includes(p.actual)).length,
      0,
    ),
  };
}
/** Bind the numerical evaluation to the actual dataset and exported-fold references. */
export function assertTrainingDataset(
  data: TriageDataset,
  output: TrainingOutput,
): void {
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  const labels = (rows: TriageDataset["rows"]) =>
    [...new Set(rows.map((row) => row.family))].sort();
  const sites = [...new Set(data.rows.map((row) => row.site))].sort();
  const fail = () => {
    throw new Error(
      "Triage fold evidence does not match dataset or ONNX references",
    );
  };
  if (
    !equal(data.features, FEATURE_NAMES) ||
    new Set(data.rows.map((row) => JSON.stringify([row.game, row.mutantId])))
      .size !== data.rows.length ||
    !equal(output.classes, labels(data.rows)) ||
    !equal(
      output.reference.features,
      data.rows.map((row) => row.features.map(Math.fround)),
    ) ||
    output.folds.length !== sites.length ||
    new Set(output.folds.map((fold) => fold.site)).size !== sites.length
  )
    fail();
  for (const fold of output.folds) {
    const held = data.rows.filter((row) => row.site === fold.site);
    const train = data.rows.filter((row) => row.site !== fold.site);
    const unseen = labels(held).filter(
      (label) => !labels(train).includes(label),
    );
    if (
      !held.length ||
      !equal(
        [...fold.trainSites].sort(),
        sites.filter((site) => site !== fold.site),
      ) ||
      !equal(fold.classes, labels(train)) ||
      !equal(fold.unseenLabels, unseen) ||
      fold.predictions.length !== held.length ||
      !equal(
        fold.reference?.features,
        held.map((row) => row.features.map(Math.fround)),
      )
    )
      fail();
    for (const [index, row] of held.entries()) {
      const prediction = fold.predictions[index];
      const probabilities = fold.reference?.probabilities[index];
      if (
        !prediction ||
        !probabilities ||
        probabilities.length !== fold.classes?.length ||
        prediction.mutantId !== row.mutantId ||
        prediction.game !== row.game ||
        prediction.actual !== row.family ||
        prediction.predicted !== fold.reference?.predictions[index] ||
        prediction.confidence !== Math.max(...probabilities)
      )
        fail();
    }
  }
}
export function evaluationMetrics(output: TrainingOutput) {
  return {
    ...accuracySummary(output),
    byGame: Object.fromEntries(
      ["platformer", "breakout"].map((game) => [
        game,
        accuracySummary({
          ...output,
          folds: output.folds.filter(
            (fold) => fold.predictions[0]?.game === game,
          ),
        }),
      ]),
    ),
  };
}
export function assertEvaluationMetrics(
  output: TrainingOutput,
  value: unknown,
): void {
  const expected = evaluationMetrics(output);
  const object = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === "object" && !Array.isArray(input);
  const keys = [
    "n",
    "sites",
    "accuracy",
    "bootstrap95",
    "unseenLabelExamples",
  ] as const;
  const same = (actual: unknown, truth: ReturnType<typeof accuracySummary>) =>
    object(actual) &&
    keys.every(
      (key) => JSON.stringify(actual[key]) === JSON.stringify(truth[key]),
    );
  if (
    !same(value, expected) ||
    !object(value) ||
    !object(value.byGame) ||
    Object.keys(value.byGame).sort().join() !==
      Object.keys(expected.byGame).sort().join() ||
    Object.entries(expected.byGame).some(
      ([game, truth]) =>
        !same((value.byGame as Record<string, unknown>)[game], truth),
    )
  )
    throw new Error(
      "Triage metrics do not match recomputed held-out accuracy and bootstrap interval",
    );
}
export async function evaluatorDigest(): Promise<string> {
  return sha256(await readFile(new URL("./train.ts", import.meta.url)));
}
export async function train(root: string, python: string): Promise<void> {
  const directory = join(root, "bench/triage");
  const local = join(root, ".local/triage");
  await mkdir(local, { recursive: true });
  const bridge = join(local, "train.py");
  await writeFile(bridge, TRAINER);
  const result = spawnSync(
    python,
    [bridge, join(directory, "dataset.json"), directory],
    {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        OMP_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        NUMEXPR_NUM_THREADS: "1",
      },
    },
  );
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `Triage training failed: ${result.error?.message ?? result.stderr}`,
    );
  const output = JSON.parse(
    await readFile(join(directory, "training.json"), "utf8"),
  ) as TrainingOutput;
  const dataset = JSON.parse(
    await readFile(join(directory, "dataset.json"), "utf8"),
  ) as TriageDataset;
  assertTrainingDataset(dataset, output);
  const summary = evaluationMetrics(output);
  const digest = sha256(await readFile(join(directory, "model.onnx")));
  await writeFile(
    join(directory, "metrics.json"),
    `${JSON.stringify({ schemaVersion: 1, datasetDigest: sha256(JSON.stringify(dataset)), modelDigest: digest, evaluatorDigest: await evaluatorDigest(), split: "leave-one-full-mutation-region-out", bootstrap: "2000 resamples of whole held-out regions, seed 1729", ...summary, limitation: "Each required platformer family and each Breakout label currently occupies one region, so holding out that region removes its label from training. The platformer other label spans three regions and remains represented when one is held out. Reported accuracy mixes these support conditions; inspect unseenLabelExamples and per-game results. Runtime full-data model scores are not calibrated probabilities." }, null, 2)}\n`,
  );
}
