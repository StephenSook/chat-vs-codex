import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import type {
  CanaryReceipt,
  JudgeEvidence,
  Receipt,
} from "../apps/judge/src/evidence.js";
import type { RegressionRecord } from "../packages/bench/src/regressions.js";
import {
  parseResultsJsonl,
  summarizeResults,
} from "../packages/bench/src/statistics.js";
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
function committedCode(source: CommittedSource): Plugin {
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
          contents: source.read(path),
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

export async function committedSimulation(
  source: CommittedSource,
): Promise<{ code: string; digest: string; track: Track }> {
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
  )) as { HELD_OUT: Track };
  const track = module.HELD_OUT;
  if (
    track?.inputs.length !== 600 ||
    track.inputs.some(
      (input) => !Number.isInteger(input) || input < 0 || input > 7,
    )
  )
    throw new Error("Unexpected committed validation track");
  return { code, digest: sha(code), track };
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
  const rounds = source
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
  };
  emit("index.json", `${JSON.stringify(manifest)}\n`);
  return { manifest, files };
}
