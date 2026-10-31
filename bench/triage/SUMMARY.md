# Triage held-out result

Real HistGradientBoosting training on the committed gated mutants. Every entire named mutation region is held out once. The 95% interval resamples whole held-out regions (2,000 draws, seed 1729).

The supported held-out class in this pool is platformer:other. Correct predictions of this catch-all do not demonstrate diagnosis of the six named families.

| Game       | Mutants | Held-out regions | Accuracy | Bootstrap 95% CI | Label absent in training |
| ---------- | ------- | ---------------- | -------- | ---------------- | ------------------------ |
| platformer | 53      | 6                | 54.7%    | 20.0% to 66.3%   | 18                       |
| breakout   | 60      | 4                | 0.0%     | 0.0% to 0.0%     | 60                       |
| Overall    | 113     | 10               | 25.7%    | 0.0% to 51.7%    | 78                       |

Each required named platformer family and each Breakout label currently occupies one region, so its holdout removes that label from training. The platformer other label spans three regions and stays represented when one is held out. Accuracy mixes these support conditions; inspect the label-absent count before drawing a conclusion. Do not replace region holdouts with candidate-level leakage. The experimental full-data runtime model is off by default and its scores are uncalibrated.

All full-data and held-out ONNX exports are checked in Node against their scikit-learn labels and complete probability vectors. Recompute: `pnpm triage:record`; verify the committed exports: `pnpm triage:check`.

## Codex hint A/B design

| Arm                     | Planned n |
| ----------------------- | --------- |
| Without hint            | 30        |
| With out-of-region hint | 30        |

Classifier accuracy does not establish a Codex speed benefit. Current runtime results are separate: `pnpm triage:ab --summary`. Review `pnpm triage:ab --plan` before running the 60 real model calls outside the build sandbox. [Design and limits](README.md).
