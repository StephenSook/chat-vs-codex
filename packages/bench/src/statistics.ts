export interface ModelSpec {
  model: string;
  effort: "low" | "high";
}

export interface TrialResult extends ModelSpec {
  schemaVersion: 1;
  trialId: string;
  batchId: string;
  mutantId: string;
  family: string;
  status: "green" | "loss" | "sandbox-blocked" | "error";
  timeToGreenMs: number | null;
  elapsedMs: number;
  exactRevert: boolean;
  filesChanged: string[];
  linesChanged: number;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  } | null;
  failureReason: string | null;
  dryRun: boolean;
  sourceDigest: string;
  startedAt: string;
  answer: {
    rootCause: string;
    file: string;
    line: number;
    explanation: string;
    confidence: number;
  } | null;
}

export interface GroupSummary {
  trials: number;
  green: number;
  fixRate: number | null;
  /** Timing statistics include green trials only. P90 uses nearest rank. */
  medianGreenMs: number | null;
  p90GreenMs: number | null;
  medianGreen95CiMs: [number, number] | null;
  exactReverts: number;
  exactRevertRateAmongGreen: number | null;
  exactRevertRateAllTrials: number | null;
  greensBeforeHeadStart: number;
  greenWithinRound: number;
  camera: "QUALIFIES" | "DOES NOT QUALIFY" | "INSUFFICIENT SAMPLE";
  gate: "GO" | "NO-GO" | "NO DATA";
}

export interface BatchSummary {
  batchId: string | null;
  sourceDigest: string | null;
  headStartMs: number;
  roundLimitMs: 60000;
  bootstrapSamples: number;
  bootstrapSeed: number;
  excludedDryRuns: number;
  models: (ModelSpec & {
    overall: GroupSummary;
    families: { family: string; metrics: GroupSummary }[];
  })[];
}

export interface SummaryOptions {
  headStartMs?: number;
  bootstrapSamples?: number;
  seed?: number;
  batchId?: string;
  sourceDigest?: string;
}

export interface ScheduleItem extends ModelSpec {
  mutantId: string;
  family: string;
}

const TRIAL_KEYS = [
  "schemaVersion",
  "trialId",
  "batchId",
  "mutantId",
  "family",
  "model",
  "effort",
  "status",
  "timeToGreenMs",
  "elapsedMs",
  "exactRevert",
  "filesChanged",
  "linesChanged",
  "usage",
  "failureReason",
  "dryRun",
  "sourceDigest",
  "startedAt",
  "answer",
];

function record(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(result, key))
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
  return result;
}

function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
}

function nonnegative(
  value: unknown,
  label: string,
  integer = false,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(
      `${label} must be a finite nonnegative ${integer ? "integer" : "number"}`,
    );
  }
}

export function parseTrialResult(value: unknown): TrialResult {
  const row = record(value, TRIAL_KEYS, "trial");
  if (row.schemaVersion !== 1)
    throw new Error("Unsupported result schemaVersion");
  for (const key of [
    "trialId",
    "batchId",
    "mutantId",
    "family",
    "model",
    "sourceDigest",
    "startedAt",
  ]) {
    string(row[key], key);
  }
  if (row.effort !== "low" && row.effort !== "high")
    throw new Error("Invalid effort");
  if (
    typeof row.status !== "string" ||
    !["green", "loss", "sandbox-blocked", "error"].includes(row.status)
  ) {
    throw new Error("Invalid status");
  }
  if (typeof row.dryRun !== "boolean" || typeof row.exactRevert !== "boolean") {
    throw new Error("dryRun and exactRevert must be booleans");
  }
  if (
    typeof row.startedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.startedAt) ||
    !Number.isFinite(Date.parse(row.startedAt)) ||
    new Date(row.startedAt).toISOString() !== row.startedAt
  )
    throw new Error("Invalid startedAt");
  nonnegative(row.elapsedMs, "elapsedMs");
  nonnegative(row.linesChanged, "linesChanged", true);
  if (
    !Array.isArray(row.filesChanged) ||
    row.filesChanged.some(
      (file) => typeof file !== "string" || file.trim().length === 0,
    )
  ) {
    throw new Error("filesChanged must be an array of nonempty paths");
  }
  if (new Set(row.filesChanged).size !== row.filesChanged.length)
    throw new Error("Duplicate changed path");
  if (row.status === "green") {
    nonnegative(row.timeToGreenMs, "timeToGreenMs");
    if (
      row.timeToGreenMs === 0 ||
      row.timeToGreenMs > row.elapsedMs ||
      row.elapsedMs > 240000
    ) {
      throw new Error(
        "Green result must finish within its elapsed time and 240000 ms deadline",
      );
    }
    if (row.failureReason !== null)
      throw new Error("Green result cannot have failureReason");
  } else {
    if (row.timeToGreenMs !== null)
      throw new Error("Non-green result cannot have timeToGreenMs");
    string(row.failureReason, "failureReason");
    if (row.exactRevert)
      throw new Error("Non-green result cannot be an exact revert");
  }
  if (row.status === "sandbox-blocked" && !row.dryRun) {
    throw new Error("Sandbox-blocked result must be a dry run");
  }
  if (row.usage !== null) {
    const usage = record(
      row.usage,
      ["input_tokens", "cached_input_tokens", "output_tokens"],
      "usage",
    );
    for (const key of Object.keys(usage)) nonnegative(usage[key], key, true);
    if (Number(usage.cached_input_tokens) > Number(usage.input_tokens)) {
      throw new Error("Cached input tokens exceed input tokens");
    }
  }
  if (row.answer !== null) {
    const answer = record(
      row.answer,
      ["rootCause", "file", "line", "explanation", "confidence"],
      "answer",
    );
    for (const key of ["rootCause", "file", "explanation"])
      string(answer[key], key);
    nonnegative(answer.line, "answer.line", true);
    if (answer.line === 0) throw new Error("Answer line must be 1-based");
    nonnegative(answer.confidence, "answer.confidence");
    if (answer.confidence > 1) throw new Error("Answer confidence exceeds 1");
  }
  return row as unknown as TrialResult;
}

export function parseResultsJsonl(text: string): TrialResult[] {
  const rows: TrialResult[] = [];
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "" && index === lines.length - 1) continue;
    try {
      const row = parseTrialResult(JSON.parse(line));
      if (ids.has(row.trialId))
        throw new Error(`Duplicate trialId ${row.trialId}`);
      ids.add(row.trialId);
      rows.push(row);
    } catch (error) {
      throw new Error(
        `Result line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return rows;
}

/** Ordinary sample median, averaging the two middle values for even samples. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) throw new Error("Missing median element");
  return sorted.length % 2 === 0 && lower !== undefined
    ? (lower + upper) / 2
    : upper;
}

/** Nearest rank, with rank ceil(p * n); input is already sorted. */
function percentile(sorted: readonly number[], p: number): number {
  const value = sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  if (value === undefined)
    throw new Error("Cannot take percentile of an empty sample");
  return value;
}

function bootstrapMedian(
  values: number[],
  samples: number,
  seed: number,
): [number, number] | null {
  if (values.length === 0) return null;
  // Xorshift32 keeps bootstrap resampling reproducible without host randomness.
  let state = seed >>> 0 || 1;
  const draw = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  const medians: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const resampled = Array.from({ length: values.length }, () => {
      const value = values[Math.floor(draw() * values.length)];
      if (value === undefined) throw new Error("Missing bootstrap element");
      return value;
    });
    const value = median(resampled);
    if (value === null) throw new Error("Empty bootstrap resample");
    medians.push(value);
  }
  medians.sort((a, b) => a - b);
  return [percentile(medians, 0.025), percentile(medians, 0.975)];
}

function summarizeGroup(
  rows: TrialResult[],
  headStartMs: number,
  samples: number,
  seed: number,
): GroupSummary {
  const greens = rows.filter((row) => row.status === "green");
  const times = greens
    .map((row) => {
      if (row.timeToGreenMs === null)
        throw new Error("Green row has no timing");
      return row.timeToGreenMs;
    })
    .sort((a, b) => a - b);
  const medianGreenMs = median(times);
  const fixRate = rows.length ? greens.length / rows.length : null;
  const exactReverts = greens.filter((row) => row.exactRevert).length;
  const greenWithinRound = times.filter((time) => time <= 60000).length;
  return {
    trials: rows.length,
    green: greens.length,
    fixRate,
    medianGreenMs,
    p90GreenMs: times.length ? percentile(times, 0.9) : null,
    medianGreen95CiMs: bootstrapMedian(times, samples, seed),
    exactReverts,
    exactRevertRateAmongGreen: greens.length
      ? exactReverts / greens.length
      : null,
    exactRevertRateAllTrials: rows.length ? exactReverts / rows.length : null,
    greensBeforeHeadStart: times.filter((time) => time < headStartMs).length,
    greenWithinRound,
    camera:
      rows.length < 10
        ? "INSUFFICIENT SAMPLE"
        : greenWithinRound / rows.length >= 0.8
          ? "QUALIFIES"
          : "DOES NOT QUALIFY",
    gate:
      rows.length === 0
        ? "NO DATA"
        : medianGreenMs !== null &&
            medianGreenMs <= 120000 &&
            fixRate !== null &&
            fixRate >= 0.7
          ? "GO"
          : "NO-GO",
  };
}

export function summarizeResults(
  input: TrialResult[],
  options: SummaryOptions = {},
): BatchSummary {
  const headStartMs = options.headStartMs ?? 15000;
  const samples = options.bootstrapSamples ?? 5000;
  const seed = options.seed ?? 20261030;
  nonnegative(headStartMs, "headStartMs");
  nonnegative(samples, "bootstrapSamples", true);
  if (samples < 100) throw new Error("At least 100 bootstrap samples required");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295)
    throw new Error("Bootstrap seed must be uint32");
  const ids = new Set<string>();
  const selected = input.map(parseTrialResult).filter((row) => {
    if (ids.has(row.trialId))
      throw new Error(`Duplicate trialId ${row.trialId}`);
    ids.add(row.trialId);
    return (
      (options.batchId === undefined || row.batchId === options.batchId) &&
      (options.sourceDigest === undefined ||
        row.sourceDigest === options.sourceDigest)
    );
  });
  const rows = selected.filter((row) => !row.dryRun);
  const batches = new Set(rows.map((row) => row.batchId));
  const sources = new Set(rows.map((row) => row.sourceDigest));
  if (batches.size > 1 || sources.size > 1)
    throw new Error(
      "Mixed batches or source digests: select one batch and source explicitly",
    );
  const specs = [
    ...new Set(rows.map((row) => JSON.stringify([row.model, row.effort]))),
  ].sort();
  return {
    batchId: [...batches][0] ?? options.batchId ?? null,
    sourceDigest: [...sources][0] ?? options.sourceDigest ?? null,
    headStartMs,
    roundLimitMs: 60000,
    bootstrapSamples: samples,
    bootstrapSeed: seed,
    excludedDryRuns: selected.length - rows.length,
    models: specs.map((spec) => {
      const [model, effort] = JSON.parse(spec) as [string, ModelSpec["effort"]];
      const modelRows = rows.filter(
        (row) => row.model === model && row.effort === effort,
      );
      return {
        model,
        effort,
        overall: summarizeGroup(modelRows, headStartMs, samples, seed),
        families: [...new Set(modelRows.map((row) => row.family))]
          .sort()
          .map((family) => ({
            family,
            metrics: summarizeGroup(
              modelRows.filter((row) => row.family === family),
              headStartMs,
              samples,
              seed,
            ),
          })),
      };
    }),
  };
}

/**
 * Bind a provisional summary to the persisted trial schedule. Repeated schedule
 * entries are intentional: each occurrence authorizes exactly one result.
 */
export function auditSchedule(
  summary: BatchSummary,
  input: TrialResult[],
  schedule: ScheduleItem[],
): BatchSummary {
  if (!schedule.length) throw new Error("Trial schedule must not be empty");
  const expected = new Map<string, number>();
  const familiesByMutant = new Map<string, string>();
  const modelSpecs = new Map<string, ModelSpec>();
  const key = (row: ScheduleItem) =>
    JSON.stringify([row.mutantId, row.family, row.model, row.effort]);
  const modelKey = (row: ModelSpec) => JSON.stringify([row.model, row.effort]);
  for (const item of schedule) {
    const value = record(
      item,
      ["mutantId", "family", "model", "effort"],
      "schedule item",
    );
    for (const field of ["mutantId", "family", "model"])
      string(value[field], field);
    if (value.effort !== "low" && value.effort !== "high")
      throw new Error("Invalid scheduled effort");
    const family = familiesByMutant.get(item.mutantId);
    if (family !== undefined && family !== item.family)
      throw new Error("Scheduled mutant has conflicting families");
    familiesByMutant.set(item.mutantId, item.family);
    expected.set(key(item), (expected.get(key(item)) ?? 0) + 1);
    modelSpecs.set(modelKey(item), { model: item.model, effort: item.effort });
  }
  const ids = new Set<string>();
  const selected = input.map(parseTrialResult).filter((row) => {
    if (ids.has(row.trialId))
      throw new Error(`Duplicate trialId ${row.trialId}`);
    ids.add(row.trialId);
    return (
      !row.dryRun &&
      (summary.batchId === null || row.batchId === summary.batchId) &&
      (summary.sourceDigest === null ||
        row.sourceDigest === summary.sourceDigest)
    );
  });
  const actual = new Map<string, number>();
  for (const row of selected) {
    const count = (actual.get(key(row)) ?? 0) + 1;
    const limit = expected.get(key(row));
    if (limit === undefined)
      throw new Error(`Unscheduled mutant, family or model: ${row.trialId}`);
    if (count > limit)
      throw new Error(
        `Too many results for scheduled mutant/model: ${row.mutantId}`,
      );
    actual.set(key(row), count);
  }
  // Recompute from bound records so a stale supplied summary cannot qualify.
  const audited = summarizeResults(selected, {
    headStartMs: summary.headStartMs,
    bootstrapSamples: summary.bootstrapSamples,
    seed: summary.bootstrapSeed,
    ...(summary.batchId === null ? {} : { batchId: summary.batchId }),
    ...(summary.sourceDigest === null
      ? {}
      : { sourceDigest: summary.sourceDigest }),
  });
  audited.excludedDryRuns = summary.excludedDryRuns;
  for (const [specKey, spec] of modelSpecs) {
    const scheduled = schedule.filter((item) => modelKey(item) === specKey);
    const complete = scheduled.every(
      (item) => actual.get(key(item)) === expected.get(key(item)),
    );
    let model = audited.models.find((item) => modelKey(item) === specKey);
    if (!model) {
      model = {
        ...spec,
        overall: summarizeGroup(
          [],
          audited.headStartMs,
          audited.bootstrapSamples,
          audited.bootstrapSeed,
        ),
        families: [],
      };
      audited.models.push(model);
    }
    for (const family of new Set(scheduled.map((item) => item.family))) {
      if (!model.families.some((item) => item.family === family)) {
        model.families.push({
          family,
          metrics: summarizeGroup(
            [],
            audited.headStartMs,
            audited.bootstrapSamples,
            audited.bootstrapSeed,
          ),
        });
      }
    }
    model.families.sort((a, b) => a.family.localeCompare(b.family));
    if (!complete) {
      for (const metrics of [
        model.overall,
        ...model.families.map((item) => item.metrics),
      ]) {
        metrics.gate = "NO DATA";
        metrics.camera = "INSUFFICIENT SAMPLE";
      }
    }
  }
  audited.models.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
  return audited;
}

export function renderSummary(summary: BatchSummary): string {
  if (!summary.models.length)
    return `NO DATA (${summary.excludedDryRuns} dry runs excluded)`;
  const seconds = (value: number | null) =>
    value === null ? "n/a" : `${(value / 1000).toFixed(2)} s`;
  const rate = (value: number | null) =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Batch: ${summary.batchId}; source: ${summary.sourceDigest}`,
    `Timing: green trials only; p90: nearest rank; bootstrap: ${summary.bootstrapSamples} samples, seed ${summary.bootstrapSeed}`,
    `Chat head start: ${seconds(summary.headStartMs)}; round: 60 s; dry runs excluded: ${summary.excludedDryRuns}`,
  ];
  for (const model of summary.models) {
    lines.push(`${model.model} (${model.effort})`);
    for (const { label, metrics } of [
      { label: "Overall", metrics: model.overall },
      ...model.families.map(({ family, metrics }) => ({
        label: family,
        metrics,
      })),
    ]) {
      const ci = metrics.medianGreen95CiMs;
      lines.push(
        `  ${label}: ${metrics.green}/${metrics.trials} green (${rate(metrics.fixRate)}); median ${seconds(metrics.medianGreenMs)}; p90 ${seconds(metrics.p90GreenMs)}; median 95% CI ${ci ? `[${seconds(ci[0])}, ${seconds(ci[1])}]` : "n/a"}; exact reverts ${metrics.exactReverts} (${rate(metrics.exactRevertRateAmongGreen)} of greens, ${rate(metrics.exactRevertRateAllTrials)} of all); before head start ${metrics.greensBeforeHeadStart}; within round ${metrics.greenWithinRound}; camera ${metrics.camera}; ${metrics.gate}`,
      );
    }
  }
  return lines.join("\n");
}
