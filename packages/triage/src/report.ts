import type { accuracySummary } from "./train.js";

type Accuracy = ReturnType<typeof accuracySummary>;
export type TriageMetrics = Accuracy & {
  datasetDigest: string;
  modelDigest: string;
  evaluatorDigest: string;
  byGame: Record<string, Accuracy>;
};
/** Canonical padded tables agree with the repository's Markdown formatter. */
export function markdownTable(rows: readonly (readonly string[])[]): string[] {
  const header = rows[0];
  if (!header) return [];
  const widths = header.map((_, index) =>
    Math.max(3, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: readonly string[]) =>
    `| ${widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ")} |`;
  return [
    line(header),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.slice(1).map(line),
  ];
}
export function renderTriageReport(metrics: TriageMetrics): string {
  const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
  const row = (name: string, value: Accuracy) => [
    name,
    String(value.n),
    String(value.sites),
    percent(value.accuracy),
    value.bootstrap95.map(percent).join(" to "),
    String(value.unseenLabelExamples),
  ];
  return [
    "# Triage held-out result",
    "",
    "Real HistGradientBoosting training on the committed gated mutants. Every entire named mutation region is held out once. The 95% interval resamples whole held-out regions (2,000 draws, seed 1729).",
    "",
    "The supported held-out class in this pool is platformer:other. Correct predictions of this catch-all do not demonstrate diagnosis of the six named families.",
    "",
    ...markdownTable([
      [
        "Game",
        "Mutants",
        "Held-out regions",
        "Accuracy",
        "Bootstrap 95% CI",
        "Label absent in training",
      ],
      ...Object.entries(metrics.byGame).map(([game, value]) =>
        row(game, value),
      ),
      row("Overall", metrics),
    ]),
    "",
    "Each required named platformer family and each Breakout label currently occupies one region, so its holdout removes that label from training. The platformer other label spans three regions and stays represented when one is held out. Accuracy mixes these support conditions; inspect the label-absent count before drawing a conclusion. Do not replace region holdouts with candidate-level leakage. The experimental full-data runtime model is off by default and its scores are uncalibrated.",
    "",
    "All full-data and held-out ONNX exports are checked in Node against their scikit-learn labels and complete probability vectors. Recompute: `pnpm triage:record`; verify the committed exports: `pnpm triage:check`.",
    "",
    "## Codex hint A/B design",
    "",
    ...markdownTable([
      ["Arm", "Planned n"],
      ["Without hint", "30"],
      ["With out-of-region hint", "30"],
    ]),
    "",
    "Classifier accuracy does not establish a Codex speed benefit. Current runtime results are separate: `pnpm triage:ab --summary`. Review `pnpm triage:ab --plan` before running the 60 real model calls outside the build sandbox. [Design and limits](README.md).",
    "",
  ].join("\n");
}
