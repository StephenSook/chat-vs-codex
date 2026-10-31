import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import {
  comparisonFrames,
  comparisonVisibleFrame,
  replayComparison,
} from "../apps/judge/src/comparison.js";
import type {
  CanaryReceipt,
  ComparisonEvidence,
  JudgeEvidence,
  Receipt,
} from "../apps/judge/src/evidence.js";
import type { GameModule } from "../apps/judge/src/proof.js";
import {
  type SecondGameEvidence,
  summarizeSecondGamePool,
  summarizeSecondGameTrials,
} from "../apps/judge/src/second-game.js";
import type { RegressionRecord } from "../packages/bench/src/regressions.js";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../packages/bench/src/statistics.js";
import {
  candidateDigest,
  mutationFingerprint,
  sourceFingerprint,
} from "../packages/mutator/src/fingerprints.js";
import { applyCandidate } from "../packages/mutator/src/index.js";
import type { Track } from "../packages/replay/src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const MAIN_SESSION_ID = "01a19004-23e3-7883-89a7-f08faee625a5";

export interface CommittedSource {
  commit: string;
  root: string;
  read(path: string): string;
  list(path: string): string[];
  commitCount(): number;
  regressionCommits(): string[];
}

export function committedSecondGame(
  source: CommittedSource,
  emit: (path: string, bytes: string) => string,
): SecondGameEvidence | null {
  const paths = new Set(source.list("games/breakout"));
  const poolPath = "games/breakout/pool.json";
  if (!paths.has(poolPath)) return null;
  const poolText = source.read(poolPath);
  const pool = summarizeSecondGamePool(poolText);
  const resultsPath = "games/breakout/bench/results.jsonl";
  let benchmark: SecondGameEvidence["benchmark"] = null;
  if (paths.has(resultsPath)) {
    const text = source.read(resultsPath);
    summarizeSecondGameTrials(text, pool.sourceDigest);
    benchmark = { path: emit(resultsPath, text), digest: sha(text) };
  }
  return {
    game: "breakout",
    pool: { ...pool, path: emit(poolPath, poolText), digest: sha(poolText) },
    benchmark,
  };
}

/** Pin one SHA before any read. Never enumerate or read working-tree evidence. */
export function committedSource(root = ROOT, ref = "HEAD"): CommittedSource {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Invalid committed evidence SHA");
  return {
    commit,
    root,
    read: (path) => git("show", `${commit}:${path}`),
    list: (path) =>
      git("ls-tree", "-r", "--name-only", commit, "--", path)
        .trim()
        .split("\n")
        .filter(Boolean),
    commitCount: () => Number(git("rev-list", "--count", commit).trim()),
    regressionCommits: () =>
      git("log", "--format=%H", commit, "--", "chat-found/*.json")
        .trim()
        .split("\n")
        .filter(Boolean),
  };
}

export function canaryReceipt(path: string, text: string): CanaryReceipt {
  const records = text
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          timestamp: string;
          value: Record<string, unknown>;
        },
    );
  const kernel = [...records]
    .reverse()
    .find((record) => record.value.kernelStatus === 0);
  if (!kernel || typeof kernel.value.stdout !== "string")
    throw new Error("No successful kernel canary");
  const controls = JSON.parse(kernel.value.stdout) as Record<
    string,
    boolean | string
  >;
  if (
    ["workspaceWrite", "testRead", "tempDirectory"].some(
      (key) => controls[key] !== true,
    )
  )
    throw new Error("Canary positive controls failed");
  if (
    ["parent", "hostSkills", "testWrite", "fixtureWrite", "network"].some(
      (key) => controls[key] !== "EPERM" && controls[key] !== "EACCES",
    )
  )
    throw new Error("Canary permission denials missing");
  const sdk = records.some(({ value }) => {
    const item = value.item as Record<string, unknown> | undefined;
    return (
      value.type === "item.completed" &&
      item?.type === "command_execution" &&
      item.status === "completed" &&
      item.exit_code === 0 &&
      item.aggregated_output === kernel.value.stdout
    );
  });
  if (
    !sdk ||
    !records.some(({ value }) => value.type === "turn.completed") ||
    !records.some(({ value }) => value.cleanValidation === "passed")
  )
    throw new Error("Canary SDK or clean validation evidence incomplete");
  return {
    path,
    digest: sha(text),
    completedAt: kernel.timestamp,
    kernelStatus: 0,
    sdkTurnCompleted: true,
    sdkOutputMatchesKernel: true,
    cleanValidation: "passed",
    controls,
  };
}

/** esbuild sees committed source bytes even if an editor has changed the sim. */
function committedCode(
  source: CommittedSource,
  overrides: Readonly<Record<string, string>> = {},
): Plugin {
  return {
    name: "committed-game-code",
    setup(plugin) {
      plugin.onResolve({ filter: /^@chat-vs-codex\/sim$/ }, () => ({
        path: join(source.root, "packages/sim/src/index.ts"),
      }));
      plugin.onResolve({ filter: /^\.\.?\// }, (args) => {
        if (!/packages\/(sim|replay)\/src\//.test(args.importer)) return;
        return {
          path: resolve(
            dirname(args.importer),
            args.path.replace(/\.js$/, ".ts"),
          ),
        };
      });
      plugin.onLoad({ filter: /packages\/(sim|replay)\/src\// }, (args) => {
        const path = relative(source.root, args.path).replaceAll("\\", "/");
        if (isAbsolute(path) || path.startsWith(".."))
          throw new Error("Source escaped committed tree");
        return {
          contents: overrides[path] ?? source.read(path),
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

export interface CommittedSimulation {
  code: string;
  digest: string;
  track: Track;
  tracks: Track[];
}

export async function committedSimulation(
  source: CommittedSource,
): Promise<CommittedSimulation> {
  const options = {
    bundle: true,
    format: "esm" as const,
    target: "es2022",
    write: false,
    sourcemap: false,
    minify: true,
    legalComments: "none" as const,
    plugins: [committedCode(source)],
  };
  const game = await build({
    ...options,
    platform: "browser",
    entryPoints: [join(source.root, "packages/sim/src/index.ts")],
  });
  const code = game.outputFiles?.[0]?.text;
  if (!code) throw new Error("Committed simulation bundle missing");
  const replay = await build({
    ...options,
    platform: "node",
    entryPoints: [join(source.root, "packages/replay/src/index.ts")],
  });
  const replayCode = replay.outputFiles?.[0]?.text;
  if (!replayCode) throw new Error("Committed replay definition missing");
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(replayCode).toString("base64")}`
  )) as { HELD_OUT: Track; TRACKS: Track[] };
  const track = module.HELD_OUT;
  if (
    track?.inputs.length !== 600 ||
    track.inputs.some(
      (input) => !Number.isInteger(input) || input < 0 || input > 7,
    )
  )
    throw new Error("Unexpected committed validation track");
  const tracks = module.TRACKS;
  if (
    !Array.isArray(tracks) ||
    !tracks.length ||
    tracks.some(
      (item) =>
        typeof item?.name !== "string" ||
        !Number.isSafeInteger(item.seed) ||
        !Array.isArray(item.inputs) ||
        !item.inputs.length ||
        item.inputs.length > 3600 ||
        item.inputs.some(
          (input) => !Number.isSafeInteger(input) || input < 0 || input > 7,
        ),
    )
  )
    throw new Error("Invalid committed display replay tracks");
  return { code, digest: sha(code), track, tracks };
}

/** Reconstruct only the original planted artifact bound to the recorded installation.
 * A historical alternate repair is unavailable unless its exact bytes are present.
 */
export async function committedComparison(
  source: CommittedSource,
  receipt: Receipt,
  regression: { path: string; digest: string } | null,
  fixedBuildDigest: string,
  emit: (path: string, bytes: string) => string,
  simulation?: CommittedSimulation,
): Promise<ComparisonEvidence> {
  const unavailable = (reason: string): ComparisonEvidence => ({
    status: "unavailable",
    reason,
  });
  if (!regression)
    return unavailable("No committed regression input and original trace.");
  if (receipt.validationReplay?.buildDigest !== fixedBuildDigest)
    return unavailable(
      "The exact recorded repair is unavailable for comparison.",
    );
  const installed = receipt.verification.builds;
  if (
    installed.length !== 2 ||
    installed.some((build) => !build.statePreserved) ||
    installed[1]?.digest !== fixedBuildDigest
  )
    return unavailable(
      "The original and repaired installations are not bound by this receipt.",
    );
  const path = regression.path.replace(/^evidence\//, "");
  const bytes = source.read(path);
  if (sha(bytes) !== regression.digest)
    throw new Error("Committed regression digest mismatch");
  const record = JSON.parse(bytes) as RegressionRecord;
  if (
    record.schemaVersion !== 1 ||
    record.roundId !== receipt.roundId ||
    record.viewer !== receipt.breaker ||
    record.mutation.id !== record.mutantId ||
    mutationFingerprint(record.mutation, record.sourceDigest) !==
      record.mutationFingerprint
  )
    throw new Error(
      "Comparison regression identity or mutation binding mismatch",
    );
  if (
    receipt.mutation &&
    (receipt.mutation.sourceDigest !== record.sourceDigest ||
      receipt.mutation.candidateDigest !== candidateDigest(record.mutation))
  )
    throw new Error("Comparison mutation does not match the round receipt");
  const clean: Record<string, string> = {};
  for (const file of source.list("packages/sim/src")) {
    if (!/^packages\/sim\/src\/[^/]+\.ts$/.test(file))
      return unavailable("Historical simulation source layout is unavailable.");
    clean[file.replace(/^packages\/sim\//, "")] = source.read(file);
  }
  if (sourceFingerprint(clean) !== record.cleanSourceDigest)
    return unavailable(
      "The original clean source is unavailable for this historical round.",
    );
  const local = record.mutation.file.replace(/^packages\/sim\//, "");
  if (!(local in clean) || local === "src/world.ts")
    throw new Error("Comparison mutation source is outside game logic");
  const original = clean[local];
  if (original === undefined)
    throw new Error("Comparison mutation source missing");
  const changed = applyCandidate(original, record.mutation);
  if (
    sourceFingerprint({ ...clean, [local]: changed }) !==
    record.brokenSourceDigest
  )
    throw new Error("Comparison broken source fingerprint mismatch");
  const routeIndex = record.routes.findIndex(
    (route) => route.firstDivergence !== null,
  );
  const route = record.routes[routeIndex];
  if (
    !route ||
    route.track.inputs.length < 1 ||
    route.track.inputs.length > 3600 ||
    route.buggy.samples.length !== route.track.inputs.length ||
    sha(JSON.stringify(route.buggy)) !== route.buggyTraceDigest
  )
    throw new Error("Comparison original trace is missing or unbound");
  const result = await build({
    entryPoints: [join(source.root, "packages/sim/src/index.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    sourcemap: false,
    minify: true,
    legalComments: "none",
    plugins: [committedCode(source, { [record.mutation.file]: changed })],
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error("Comparison original artifact missing");
  const brokenBuildDigest = sha(code);
  if (brokenBuildDigest !== installed[0]?.digest)
    return unavailable(
      "The original installed build cannot be reproduced exactly.",
    );
  const fixedSimulation = simulation ?? (await committedSimulation(source));
  if (
    fixedSimulation.digest !== fixedBuildDigest ||
    sha(fixedSimulation.code) !== fixedBuildDigest
  )
    throw new Error("Display witness repaired artifact digest mismatch");
  const importGame = (bytes: string): Promise<GameModule> =>
    import(
      `data:text/javascript;base64,${Buffer.from(bytes).toString("base64")}`
    );
  const brokenGame = await importGame(code);
  const fixedGame = await importGame(fixedSimulation.code);
  let display:
    | Extract<ComparisonEvidence, { status: "available" }>["display"]
    | undefined;
  for (const track of [...fixedSimulation.tracks, fixedSimulation.track]) {
    const broken = comparisonFrames(brokenGame, track);
    const fixed = comparisonFrames(fixedGame, track);
    const visibleFrame = comparisonVisibleFrame(fixedGame, broken, fixed);
    const firstDivergence = fixed.find(
      (frame, index) => frame.stateHash !== broken[index]?.stateHash,
    )?.frame;
    if (visibleFrame === null || firstDivergence === undefined) continue;
    display = {
      track,
      trackDigest: sha(JSON.stringify(track)),
      brokenFramesDigest: sha(JSON.stringify(broken)),
      fixedFramesDigest: sha(JSON.stringify(fixed)),
      firstDivergence,
      visibleFrame,
    };
    break;
  }
  if (!display)
    return unavailable(
      "No replay exposes a visible original glitch within 10 seconds.",
    );
  const comparison: Extract<ComparisonEvidence, { status: "available" }> = {
    status: "available",
    brokenArtifactPath: `evidence/broken-${brokenBuildDigest}.js`,
    brokenBuildDigest,
    fixedBuildDigest,
    regressionPath: regression.path,
    regressionDigest: regression.digest,
    routeIndex,
    display,
  };
  // Prove the original recorded oracle and the newly selected visible witness.
  // The browser repeats these simulations from downloaded, byte-verified modules.
  await replayComparison(brokenGame, fixedGame, comparison, record, receipt);
  comparison.brokenArtifactPath = emit(`broken-${brokenBuildDigest}.js`, code);
  return comparison;
}

export async function buildJudgeEvidence(
  source = committedSource(),
): Promise<{ manifest: JudgeEvidence; files: Map<string, string> }> {
  const files = new Map<string, string>();
  const emit = (path: string, bytes: string): string => {
    const asset = `evidence/${path}`;
    files.set(asset, bytes);
    return asset;
  };
  const results = source.read("bench/results.jsonl");
  const rows = parseResultsJsonl(results);
  const batches = [
    ...new Set(rows.filter((row) => !row.dryRun).map((row) => row.batchId)),
  ];
  const ranked = batches
    .map((batchId) => ({
      batchId,
      count: rows.filter((row) => row.batchId === batchId && !row.dryRun)
        .length,
    }))
    .sort((a, b) => b.count - a.count || a.batchId.localeCompare(b.batchId));
  const batchId = ranked[0]?.batchId;
  if (!batchId) throw new Error("No committed benchmark results");
  summarizeResults(rows, { batchId });
  const regressions = new Map(
    source
      .list("chat-found")
      .filter((path) => /^chat-found\/[a-f0-9-]{36}\.json$/.test(path))
      .map((path) => {
        const text = source.read(path);
        const record = JSON.parse(text) as RegressionRecord;
        if (
          record.schemaVersion !== 1 ||
          path !== `chat-found/${record.roundId}.json` ||
          !/^viewer-[a-f0-9]{16}$/.test(record.viewer) ||
          !record.routes?.length
        )
          throw new Error(`Invalid committed regression: ${path}`);
        emit(path, text);
        return [
          record.roundId,
          {
            path: `evidence/${path}`,
            digest: sha(text),
            retroactive: record.retroactive,
            viewer: record.viewer,
          },
        ] as const;
      }),
  );
  const rounds: JudgeEvidence["rounds"] = source
    .list("docs/rounds")
    .filter((path) => /^docs\/rounds\/[a-f0-9-]{36}\.json$/.test(path))
    .map((path) => {
      const text = source.read(path);
      const receipt = JSON.parse(text) as Receipt;
      if (
        receipt.schemaVersion !== 1 ||
        path !== `docs/rounds/${receipt.roundId}.json` ||
        receipt.verification?.fullReplaySuite !== true ||
        receipt.verification.heldOutReplay !== true
      )
        throw new Error(`Invalid committed round receipt: ${path}`);
      const credited = regressions.get(receipt.roundId);
      if (credited && credited.viewer !== receipt.breaker)
        throw new Error(
          `Regression credit does not match round receipt: ${path}`,
        );
      const regression = credited
        ? {
            path: credited.path,
            digest: credited.digest,
            retroactive: credited.retroactive,
          }
        : null;
      if (
        receipt.autopsy?.regressionTest &&
        (!regression ||
          receipt.autopsy.regressionTest.digest !== regression.digest)
      )
        throw new Error(`Regression does not match round receipt: ${path}`);
      return { path: emit(path, text), digest: sha(text), receipt, regression };
    });
  if (!rounds.length) throw new Error("No committed round receipts");
  const candidates: CanaryReceipt[] = [];
  for (const path of source
    .list("bench/runs")
    .filter((path) => /\/canary-[a-f0-9-]+\.jsonl$/.test(path))) {
    try {
      candidates.push(canaryReceipt(path, source.read(path)));
    } catch {
      /* Historical incomplete probes are not successful receipts. */
    }
  }
  candidates.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const canary = candidates[0];
  if (!canary) throw new Error("No complete committed sandbox canary receipt");
  emit("sandbox-canary.json", `${JSON.stringify(canary, null, 2)}\n`);
  const simulation = await committedSimulation(source);
  const artifactPath = emit(`game-${simulation.digest}.js`, simulation.code);
  for (const round of rounds)
    round.comparison = await committedComparison(
      source,
      round.receipt,
      round.regression,
      simulation.digest,
      emit,
      simulation,
    );
  const commitCount = source.commitCount();
  if (!Number.isSafeInteger(commitCount) || commitCount < 1)
    throw new Error("Invalid committed graph count");
  const manifest: JudgeEvidence = {
    schemaVersion: 1,
    commit: source.commit,
    commitCount,
    sessionId: MAIN_SESSION_ID,
    benchmark: {
      path: emit("bench/results.jsonl", results),
      digest: sha(results),
      batchId,
    },
    regressionCount: regressions.size,
    regressionCommits: source.regressionCommits(),
    rounds,
    replay: {
      artifactPath,
      buildDigest: simulation.digest,
      track: simulation.track,
    },
    canary,
    secondGame: committedSecondGame(source, emit),
  };
  emit("index.json", `${JSON.stringify(manifest)}\n`);
  return { manifest, files };
}
