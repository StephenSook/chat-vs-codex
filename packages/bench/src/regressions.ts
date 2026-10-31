import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  mutationFingerprint,
  sourceFingerprint,
} from "../../mutator/src/fingerprints.js";
import type { PooledMutant } from "../../mutator/src/gate.js";

export {
  mutationFingerprint,
  sourceFingerprint,
} from "../../mutator/src/fingerprints.js";

import { applyCandidate, type Candidate } from "../../mutator/src/index.js";
import { runBounded } from "../../mutator/src/process.js";
import { trustedOriginalMutation } from "../../mutator/src/trust.js";
import {
  CANARY,
  MAX_FRAMES,
  runTrack,
  TRACKS,
  type Track,
} from "../../replay/src/index.js";
import { confinedBundlePlugin } from "./confined-bundle.js";
import type { TrialWorkspace } from "./workspace.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const REGRESSIONS_DIRECTORY = join(ROOT, "chat-found");
const sha = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const roundPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Replay = ReturnType<typeof runTrack>;
type Trace = Pick<Replay, "hashes" | "outcome" | "samples">;
export interface RegressionRoute {
  role: "canary" | "witness";
  track: Track;
  expected: {
    hashes: Replay["hashes"];
    outcome: Replay["outcome"];
    checkpoints: { frame: number; hash: string }[];
  };
  buggy: Trace;
  buggyTraceDigest: string;
  firstDivergence: number | null;
}
export interface RegressionProof {
  sourceDigest: string;
  cleanSourceDigest: string;
  brokenSourceDigest: string;
  mutationFingerprint: string;
  mutantId: string;
  mutation: Candidate;
  routes: RegressionRoute[];
}
export interface RegressionRecord extends RegressionProof {
  schemaVersion: 1;
  roundId: string;
  viewer: string;
  createdAt: string;
  retroactive: boolean;
}
export interface NeutralRegression {
  name: string;
  routes: { track: Track; expected: RegressionRoute["expected"] }[];
}

function candidateOnly(candidate: Candidate): Candidate {
  return {
    id: candidate.id,
    file: candidate.file,
    site: candidate.site,
    mutator: candidate.mutator,
    location: candidate.location,
    original: candidate.original,
    replacement: candidate.replacement,
  };
}
export function regressionDigest(records: readonly RegressionRecord[]): string {
  return sha([...records].sort((a, b) => a.roundId.localeCompare(b.roundId)));
}
function boundedTrack(track: Track): void {
  if (
    !track ||
    typeof track.name !== "string" ||
    !Number.isSafeInteger(track.seed) ||
    !Array.isArray(track.inputs) ||
    !track.inputs.length ||
    track.inputs.length > MAX_FRAMES ||
    track.inputs.some(
      (input) => !Number.isSafeInteger(input) || input < 0 || input > 7,
    )
  )
    throw new Error("Invalid regression track");
}
function assertTrace(trace: Trace, track: Track): void {
  if (
    !trace ||
    !Array.isArray(trace.samples) ||
    trace.samples.length !== track.inputs.length
  )
    throw new Error("Invalid regression trace budget");
  if (
    Object.keys(trace).some(
      (key) => !["hashes", "outcome", "samples"].includes(key),
    )
  )
    throw new Error("Unexpected regression trace metadata");
  for (const [index, frame] of trace.samples.entries())
    if (
      !frame ||
      frame.frame !== index + 1 ||
      !Number.isSafeInteger(frame.x) ||
      !Number.isSafeInteger(frame.y) ||
      typeof frame.alive !== "boolean" ||
      typeof frame.won !== "boolean" ||
      !/^[a-f0-9]{8}$/.test(frame.stateHash)
    )
      throw new Error("Invalid regression trace frame");
  if (
    trace.samples.some((frame) =>
      Object.keys(frame).some(
        (key) =>
          !["frame", "x", "y", "alive", "won", "stateHash"].includes(key),
      ),
    )
  )
    throw new Error("Unexpected regression frame metadata");
  const hashes = trace.samples
    .filter((frame) => frame.frame % 60 === 0)
    .map((frame) => ({ frame: frame.frame, hash: frame.stateHash }));
  const last = trace.samples.at(-1);
  if (
    !last ||
    JSON.stringify(hashes) !== JSON.stringify(trace.hashes) ||
    JSON.stringify({
      frame: last.frame,
      x: last.x,
      y: last.y,
      alive: last.alive,
      won: last.won,
    }) !== JSON.stringify(trace.outcome)
  )
    throw new Error("Inconsistent regression trace");
}
function route(
  track: Track,
  buggy: Trace,
  role: RegressionRoute["role"],
): RegressionRoute {
  boundedTrack(track);
  assertTrace(buggy, track);
  const clean = runTrack(track);
  const firstDivergence =
    clean.samples.find(
      (frame, index) => frame.stateHash !== buggy.samples[index]?.stateHash,
    )?.frame ?? null;
  return {
    role,
    track,
    expected: {
      hashes: clean.hashes,
      outcome: clean.outcome,
      checkpoints:
        firstDivergence === null
          ? []
          : [
              {
                frame: firstDivergence,
                hash: clean.samples[firstDivergence - 1]?.stateHash ?? "",
              },
            ],
    },
    buggy,
    buggyTraceDigest: sha(buggy),
    firstDivergence,
  };
}

/** Verify persisted proof, rather than trusting an asserted killed/survived flag. */
export function parseRegression(value: unknown): RegressionRecord {
  if (!value || typeof value !== "object")
    throw new Error("Invalid regression record");
  const row = value as RegressionRecord;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "sourceDigest",
          "cleanSourceDigest",
          "brokenSourceDigest",
          "mutationFingerprint",
          "mutantId",
          "mutation",
          "routes",
          "schemaVersion",
          "roundId",
          "viewer",
          "createdAt",
          "retroactive",
        ].includes(key),
    )
  )
    throw new Error("Unexpected regression metadata");
  if (
    row.schemaVersion !== 1 ||
    !roundPattern.test(row.roundId) ||
    !/^viewer-[a-f0-9]{16}$/.test(row.viewer) ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.retroactive !== "boolean" ||
    ![
      row.sourceDigest,
      row.cleanSourceDigest,
      row.brokenSourceDigest,
      row.mutationFingerprint,
    ].every(
      (digest) => typeof digest === "string" && digestPattern.test(digest),
    ) ||
    typeof row.mutantId !== "string" ||
    !/^[a-f0-9]{16}$/.test(row.mutantId) ||
    !Array.isArray(row.routes) ||
    row.routes.length < 1 ||
    row.routes.length > 2
  )
    throw new Error("Invalid regression metadata");
  if (
    !row.mutation ||
    row.mutation.id !== row.mutantId ||
    mutationFingerprint(row.mutation, row.sourceDigest) !==
      row.mutationFingerprint
  )
    throw new Error("Regression mutation fingerprint mismatch");
  if (
    JSON.stringify(candidateOnly(row.mutation)) !== JSON.stringify(row.mutation)
  )
    throw new Error("Unexpected mutation metadata");
  if (
    JSON.stringify(row.routes[0]?.track) !== JSON.stringify(CANARY) ||
    row.routes[0]?.role !== "canary"
  )
    throw new Error("Regression must retain the real canary input track");
  for (const item of row.routes) {
    const recomputed = route(item.track, item.buggy, item.role);
    if (JSON.stringify(recomputed) !== JSON.stringify(item))
      throw new Error(
        "Regression proof does not match its clean checkpoints or buggy trace",
      );
  }
  const canary = row.routes[0];
  if (
    !canary ||
    canary.buggy.samples.some((frame) => !frame.alive || frame.won) ||
    canary.buggy.outcome.frame < 1200
  )
    throw new Error("Original mutant canary did not survive 20 seconds");
  if (!row.routes.some((item) => item.firstDivergence !== null))
    throw new Error("Canary survival alone does not kill the original mutant");
  if (
    row.routes.length === 2 &&
    (canary.firstDivergence !== null ||
      row.routes[1]?.role !== "witness" ||
      !TRACKS.some(
        (track) =>
          JSON.stringify(track) === JSON.stringify(row.routes[1]?.track),
      ))
  )
    throw new Error("Invalid supplementary regression witness");
  return structuredClone(row);
}

export async function loadRegressions(
  directory = REGRESSIONS_DIRECTORY,
): Promise<RegressionRecord[]> {
  const files = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const records: RegressionRecord[] = [];
  for (const name of files.filter((name) => name.endsWith(".json")).sort()) {
    const record = parseRegression(
      JSON.parse(await readFile(join(directory, name), "utf8")),
    );
    if (name !== `${record.roundId}.json`)
      throw new Error("Regression filename does not match its round");
    const clean: Record<string, string> = {};
    for (const file of (await readdir(join(ROOT, "packages/sim/src"))).sort())
      clean[`src/${file}`] = await readFile(
        join(ROOT, "packages/sim/src", file),
        "utf8",
      );
    if (sourceFingerprint(clean) !== record.cleanSourceDigest)
      throw new Error("Regression clean source is stale");
    const local = record.mutation.file.replace(/^packages\/sim\//, "");
    if (!(local in clean))
      throw new Error("Regression mutation source missing");
    const broken = {
      ...clean,
      [local]: applyCandidate(clean[local] ?? "", record.mutation),
    };
    if (sourceFingerprint(broken) !== record.brokenSourceDigest)
      throw new Error("Regression broken source binding mismatch");
    records.push(record);
  }
  return records;
}
export function eligibleMutants<T extends Candidate>(
  mutants: readonly T[],
  sourceDigest: string,
  records: readonly RegressionRecord[],
): T[] {
  const learned = new Set(
    records
      .filter((record) => record.sourceDigest === sourceDigest)
      .map((record) => record.mutationFingerprint),
  );
  return mutants.filter(
    (mutant) => !learned.has(mutationFingerprint(mutant, sourceDigest)),
  );
}
export function neutralRegressions(
  records: readonly RegressionRecord[],
  cleanSourceDigest: string,
): NeutralRegression[] {
  return records
    .filter((record) => record.cleanSourceDigest === cleanSourceDigest)
    .map((record, index) => ({
      name: `regression-${String(index + 1).padStart(4, "0")}`,
      routes: record.routes.map(({ track, expected }, routeIndex) => ({
        track: { ...track, name: `route-${routeIndex + 1}` },
        expected,
      })),
    }));
}

/** Runs only a byte-verified ORIGINAL planted build, before any runtime SDK starts.
 * This offline bounded worker is not a substitute for patched-code sandbox validation. */
export async function captureRegression(
  workspace: TrialWorkspace,
  mutant: PooledMutant,
  sourceDigest: string,
): Promise<RegressionProof> {
  if (!(await trustedOriginalMutation(mutant, sourceDigest)))
    throw new Error(
      "Regression worker requires a trusted pooled original or enumerated original mutant",
    );
  const sources: Record<string, string> = {};
  const local = mutant.file.replace(/^packages\/sim\//, "");
  for (const [path, clean] of Object.entries(workspace.cleanSources)) {
    const trusted = await readFile(join(ROOT, "packages/sim", path), "utf8");
    if (trusted !== clean)
      throw new Error(
        "Regression clean source does not match trusted simulation",
      );
    const actual = await readFile(join(workspace.game, path), "utf8");
    if (actual !== (path === local ? applyCandidate(clean, mutant) : clean))
      throw new Error(
        "Regression worker accepts only the original planted source",
      );
    sources[path] = actual;
  }
  if (!(local in sources) || !digestPattern.test(sourceDigest))
    throw new Error("Invalid regression source binding");
  const tracks = [CANARY, ...TRACKS];
  const outfile = join(
    workspace.game,
    ".tmp",
    `regression-${randomUUID()}.mjs`,
  );
  try {
    await build({
      stdin: {
        contents: `import { createState,step,hashState } from ${JSON.stringify(join(workspace.game, "src/index.ts"))};
const tracks=${JSON.stringify(tracks)};const results=tracks.map(track=>{if(!track.inputs.length||track.inputs.length>3600)throw new Error('frame budget');let state=createState(track.seed);const hashes=[],samples=[];for(const input of track.inputs){state=step(state,input);const frame={frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won,stateHash:hashState(state)};samples.push(frame);if(state.frame%60===0)hashes.push({frame:state.frame,hash:frame.stateHash});}return {hashes,samples,outcome:{frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won}};});console.log(JSON.stringify(results));`,
        loader: "ts",
        resolveDir: workspace.game,
      },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      plugins: [confinedBundlePlugin(workspace.game)],
    });
    const results = JSON.parse(
      runBounded(process.execPath, [outfile], workspace.game, 3000),
    ) as Trace[];
    if (
      !Array.isArray(results) ||
      results.length !== tracks.length ||
      !results[0]
    )
      throw new Error("Missing original mutant regression traces");
    const routes = [route(CANARY, results[0], "canary")];
    if (routes[0]?.firstDivergence === null) {
      for (const [index, track] of TRACKS.entries()) {
        const buggy = results[index + 1];
        if (!buggy) throw new Error("Missing witness trace");
        const witness = route(track, buggy, "witness");
        if (witness.firstDivergence !== null) {
          routes.push(witness);
          break;
        }
      }
    }
    const proof = {
      sourceDigest,
      cleanSourceDigest: sourceFingerprint(workspace.cleanSources),
      brokenSourceDigest: sourceFingerprint(sources),
      mutationFingerprint: mutationFingerprint(mutant, sourceDigest),
      mutantId: mutant.id,
      mutation: candidateOnly(mutant),
      routes,
    };
    // Reuse the persistence parser to prove clean pass, survival and a real kill now.
    parseRegression({
      ...proof,
      schemaVersion: 1,
      roundId: "00000000-0000-0000-0000-000000000000",
      viewer: "viewer-0000000000000000",
      createdAt: new Date().toISOString(),
      retroactive: false,
    });
    return proof;
  } finally {
    await rm(outfile, { force: true });
  }
}

/** Link a fully written temporary file atomically; never overwrite a credited round. */
export async function persistRegression(
  directory: string,
  proof: RegressionProof,
  credit: { roundId: string; viewer: string },
  options: { createdAt?: string; retroactive?: boolean } = {},
): Promise<{ path: string; digest: string }> {
  const record = parseRegression({
    ...proof,
    ...credit,
    schemaVersion: 1,
    createdAt: options.createdAt ?? new Date().toISOString(),
    retroactive: options.retroactive ?? false,
  });
  const path = join(directory, `${record.roundId}.json`);
  await mkdir(directory, { recursive: true });
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = parseRegression(
        JSON.parse(await readFile(path, "utf8")),
      );
      if (
        JSON.stringify({ ...existing, createdAt: record.createdAt }) !==
        JSON.stringify(record)
      )
        throw new Error("Refusing to replace different regression credit");
    }
    const persisted = await readFile(path);
    return {
      path: `chat-found/${record.roundId}.json`,
      digest: createHash("sha256").update(persisted).digest("hex"),
    };
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Reconstruct proof for an already recorded real round, without another model call.
 * Returns evidence for review only. The caller separately authorizes persistence. */
export async function retroactiveRegression(input: {
  directory: string;
  runtimeLog: string;
  receiptPath: string;
}): Promise<{
  proof: RegressionProof;
  credit: { roundId: string; viewer: string };
  binding: {
    mutantId: string;
    cleanBuildDigest: string;
    brokenBuildDigest: string;
  };
  retroactive: true;
}> {
  const result = JSON.parse(
    await readFile(join(input.directory, "result.json"), "utf8"),
  );
  const receipt = JSON.parse(await readFile(input.receiptPath, "utf8"));
  const roundId: unknown = result.result?.roundId;
  if (
    typeof roundId !== "string" ||
    !roundPattern.test(roundId) ||
    result.result.phase !== "resolved" ||
    result.client?.broadcast?.bug !== "fixed" ||
    receipt.roundId !== roundId ||
    !/^viewer-[a-f0-9]{16}$/.test(receipt.breaker) ||
    receipt.verification?.fullReplaySuite !== true ||
    receipt.verification?.heldOutReplay !== true ||
    receipt.verification?.statePreserved !== true
  )
    throw new Error(
      "Retroactive credit requires a verified private result and public receipt",
    );
  const runtime = (
    await readFile(join(input.directory, input.runtimeLog), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const prepared = runtime.filter(
    (row) => row.kind === "round.prepared" && row.roundId === roundId,
  );
  const verified = runtime.filter((row) => row.kind === "repair.verified");
  if (prepared.length !== 1 || verified.length !== 1)
    throw new Error("Missing unique private preparation and repair evidence");
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { sourceDigest: string; mutants: PooledMutant[] };
  const { sourceDigest } = await import("../../mutator/src/gate.js");
  if (pool.sourceDigest !== (await sourceDigest()))
    throw new Error("Retroactive mutation pool is stale");
  const mutant = pool.mutants.find(
    (candidate) => candidate.id === prepared[0]?.mutantId,
  );
  if (!mutant || mutant.family !== prepared[0]?.family)
    throw new Error("Retroactive original mutant is unavailable");
  const events = (await readFile(join(input.directory, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const builds = events
    .map((envelope) => envelope.event)
    .filter(
      (event) => event?.type === "game.build" && event.roundId === roundId,
    );
  if (
    builds.length !== 2 ||
    builds[0]?.phase !== "broken" ||
    builds[1]?.phase !== "repaired"
  )
    throw new Error(
      "Retroactive round did not perform exactly one broken and repaired install",
    );
  const { prepareWorkspace } = await import("./workspace.js");
  const workspace = await prepareWorkspace(mutant);
  try {
    const proof = await captureRegression(workspace, mutant, pool.sourceDigest);
    const browserDigest = async (entry: string, confined?: string) => {
      const bundled = await build({
        entryPoints: [entry],
        bundle: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        write: false,
        sourcemap: false,
        minify: true,
        legalComments: "none",
        ...(confined ? { plugins: [confinedBundlePlugin(confined)] } : {}),
      });
      const code = bundled.outputFiles[0]?.text;
      if (!code) throw new Error("Missing retroactive original artifact");
      return createHash("sha256").update(code).digest("hex");
    };
    const cleanBuildDigest = await browserDigest(
      join(ROOT, "packages/sim/src/index.ts"),
    );
    const brokenBuildDigest = await browserDigest(
      join(workspace.game, "src/index.ts"),
      workspace.game,
    );
    const expected = [brokenBuildDigest, cleanBuildDigest];
    if (
      verified[0]?.digest !== cleanBuildDigest ||
      result.client.buildId !== cleanBuildDigest ||
      builds.some(
        (event, index) =>
          event.digest !== expected[index] || event.buildId !== expected[index],
      ) ||
      !Array.isArray(result.client.installs) ||
      result.client.installs.length !== 2 ||
      result.client.installs.some(
        (
          install: { buildId: string; statePreserved: boolean },
          index: number,
        ) => !install.statePreserved || install.buildId !== expected[index],
      ) ||
      !Array.isArray(receipt.verification.builds) ||
      receipt.verification.builds.length !== 2 ||
      receipt.verification.builds.some(
        (install: { digest: string; statePreserved: boolean }, index: number) =>
          !install.statePreserved || install.digest !== expected[index],
      )
    )
      throw new Error(
        "Retroactive source artifacts do not match recorded private and public evidence",
      );
    return {
      proof,
      credit: { roundId, viewer: receipt.breaker },
      binding: { mutantId: mutant.id, cleanBuildDigest, brokenBuildDigest },
      retroactive: true,
    };
  } finally {
    await workspace.cleanup();
  }
}
