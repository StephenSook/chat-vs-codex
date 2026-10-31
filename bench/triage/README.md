# Telemetry triage experiment

This experiment predicts a bug family from broken replay telemetry. It does not read the planted source, replacement, location, clean telemetry or family label as a feature. All accepted mutants from both committed pools are included. Breakout includes hitBrick as well as the three benchmarked sites.

Run from the repository root:

```sh
pnpm triage:setup
pnpm triage:record
pnpm triage:check
pnpm triage:ab --plan
```

The setup command requires Python 3.12 (`TRIAGE_BOOTSTRAP_PYTHON` overrides the bootstrap executable); the normal Node CI gate does not install or run Python.

Training uses the actual pinned scikit-learn HistGradientBoostingClassifier through an external Python toolchain. Application orchestration, telemetry extraction, evaluation, runtime inference and the benchmark harness are TypeScript. The generated Python bridge remains under .local; its SHA-256 and package versions are recorded. The deterministic model uses one CPU thread. ONNX exports are checked with onnx.checker and their predictions compared against scikit-learn using onnxruntime-node.

Hold out each entire named mutation region in turn. Bootstrap 2,000 samples of whole regions with seed 1729; individual mutants from one region never appear on both sides of a fold. Each of the six required named platformer families and each Breakout label occupies one named region. Holding out that region removes its label from training. The retained platformer `other` label spans collision, input and physics, so it remains present in training when any one of those regions is held out. No labels are dropped or relabelled by site. The measured accuracy mixes supported and unseen-label cases; report both the label-absent count and per-game metrics. Do not replace this split with a leaky candidate-level split. Add independent same-family regions before claiming generalization for the named families. The internal classifier catch-all does not expand chat's six-family `!guess` enum.

`TRIAGE_ENABLED=1` opts into an experimental, uncalibrated full-data model readout. The chip appears only after the 15-second chat head start. `TRIAGE_HINT=1` additionally supplies that enum-only hypothesis to Codex. Both default off. These runtime full-data scores are not held-out performance or calibrated confidence.

## A/B design

The immutable plan contains 30 distinct paired mutants, exactly 30 trials per arm, using Terra low. Each pair plants the same bug in two fresh neutral isolated workspaces; the order within each pair is seeded and randomized. One arm receives only the existing observable ticket. The other adds the classifier's out-of-region guess, including wrong guesses. A/B hints come from the fold that excluded that mutant's full region; their ONNX model digest is retained. The planted family's true label, site, operator and clean source are never added to either ticket.

```sh
pnpm triage:ab --run
pnpm triage:ab --summary
```

This is 60 real model calls. Stephen runs them outside the build sandbox after reviewing the plan. No trials have been executed as part of implementation. The baseline benchmark files are untouched. A new batch has its own immutable manifest, private runtime workspaces and public event/results evidence under bench/triage. Every loss stays in the denominator, no retries. The original sandbox preflight, immutable tests, held-out route, per-workspace TMPDIR and 240-second hard budget remain in force. Publish the results whatever their direction; before the 60 planned rows exist, the summary prints PENDING and makes no effect claim. Infrastructure losses remain losses.
