import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  eligibleMutants,
  loadRegressions,
} from "../../bench/src/regressions.js";
import {
  compareReplay,
  type ReplayEvidence,
  type ReplayResult,
} from "./evidence.js";
import { applyCandidate, type Candidate, enumerate } from "./index.js";
import { runBounded } from "./process.js";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const FAMILIES = [
  "gravity-sign",
  "collision-off-by-one",
  "swapped-controls",
  "coyote-never-expires",
  "jump-buffer",
  "enemy-ledge-turn",
] as const;

export interface PooledMutant extends Candidate {
  family: string;
  failedReplays: string[];
  evidence: ReplayEvidence[];
  gates: {
    typecheck: true;
    differentMinifiedOutput: true;
    killed: true;
    visible: true;
    frameBudget: number;
    processBudgetMs: number;
    canaryFrames: number;
  };
}

export async function sourceDigest(root = ROOT): Promise<string> {
  const hash = createHash("sha256");
  for (const dir of [
    "packages/sim/src",
    "packages/replay/src",
    "packages/replay/fixtures",
  ]) {
    for (const file of (await readdir(join(root, dir))).sort()) {
      hash.update(
        JSON.stringify([
          `${dir}/${file}`,
          await readFile(join(root, dir, file), "utf8"),
        ]),
      );
    }
  }
  hash.update(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  return hash.digest("hex");
}

export function operatorFamily(candidate: Candidate): string {
  if (
    candidate.site === "physics" &&
    /^vy \+ (?:GRAVITY|RISE_GRAVITY|FALL_GRAVITY)$/.test(candidate.original) &&
    candidate.replacement === candidate.original.replace(" + ", " - ")
  )
    return "gravity-sign";
  if (
    candidate.site === "input" &&
    /^0 - direction \* (?:SPEED|AIR_SPEED|PLATFORM_SPEED)$/.test(
      candidate.original,
    ) &&
    candidate.replacement === candidate.original.replace("0 -", "0 +")
  )
    return "swapped-controls";
  if (
    candidate.site === "collision" &&
    candidate.mutator === "EqualityOperator"
  ) {
    const before = candidate.original.replace(/\s/g, "");
    const after = candidate.replacement.replace(/\s/g, "");
    const operators = before.match(/<=|>=|<|>/g);
    const op = operators?.[0];
    if (operators?.length === 1 && op) {
      const inclusive = op.endsWith("=") ? op.slice(0, -1) : `${op}=`;
      if (before.replace(op, inclusive) === after)
        return "collision-off-by-one";
    }
  }
  if (
    candidate.site === "coyote" &&
    candidate.original === "state.coyote - 1" &&
    candidate.replacement === "state.coyote + 1"
  )
    return "coyote-never-expires";
  if (candidate.site === "buffer") return "jump-buffer";
  if (candidate.site === "enemy") return "enemy-ledge-turn";
  return "other";
}

async function minified(root: string): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "packages/sim/src/index.ts")],
    bundle: true,
    write: false,
    minify: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error("Empty minified build");
  return code;
}

interface Execution {
  tracks: { name: string; result: ReplayResult }[];
  canary: ReplayResult;
}

async function execute(root: string, scratch: string): Promise<Execution> {
  const entry = join(scratch, "runner.ts");
  await writeFile(
    entry,
    `
    import { TRACKS, CANARY, runTrack } from ${JSON.stringify(join(root, "packages/replay/src/index.ts"))};
    const requested = process.argv[2];
    const track = requested === 'canary' ? CANARY : TRACKS.find(t => t.name === requested);
    if (!track || track.inputs.length > 3600) throw new Error('Replay exceeds frame budget');
    console.log(JSON.stringify(runTrack(track)));
  `,
  );
  const outfile = join(scratch, "runner.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@chat-vs-codex/sim": join(root, "packages/sim/src/index.ts") },
  });
  const { TRACKS } = await import("../../replay/src/index.js");
  const tracks = TRACKS.map((track) => ({
    name: track.name,
    result: JSON.parse(
      runBounded(process.execPath, [outfile, track.name], scratch, 3000),
    ) as ReplayResult,
  }));
  const canary = JSON.parse(
    runBounded(process.execPath, [outfile, "canary"], scratch, 3000),
  ) as ReplayResult;
  return { tracks, canary };
}

/** All generated and executed code stays in disposable offline workspaces. */
export async function generatePool(): Promise<void> {
  const digest = await sourceDigest();
  const parent = await mkdtemp(join(tmpdir(), "mutation-gate-"));
  const workspace = join(parent, "game");
  try {
    await mkdir(workspace);
    for (const pkg of ["sim", "replay"]) {
      await cp(join(ROOT, "packages", pkg), join(workspace, "packages", pkg), {
        recursive: true,
        filter: (path) => !path.includes("node_modules"),
      });
      await symlink(
        join(ROOT, "packages", pkg, "node_modules"),
        join(workspace, "packages", pkg, "node_modules"),
        "dir",
      );
    }
    await symlink(
      join(ROOT, "node_modules"),
      join(workspace, "node_modules"),
      "dir",
    );
    await writeFile(join(workspace, "package.json"), '{"type":"module"}');
    await cp(
      join(ROOT, "tsconfig.base.json"),
      join(workspace, "tsconfig.base.json"),
    );
    await writeFile(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
        include: ["packages/sim/src/**/*.ts"],
      }),
    );
    const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
    const checkTypes = () =>
      runBounded(
        process.execPath,
        [tsc, "--noEmit", "-p", join(workspace, "tsconfig.json")],
        workspace,
        15000,
      );
    checkTypes();
    const cleanCode = await minified(workspace);
    const clean = await execute(workspace, parent);
    const goldens = JSON.parse(
      await readFile(
        join(ROOT, "packages/replay/fixtures/goldens.json"),
        "utf8",
      ),
    ) as Record<string, Pick<ReplayResult, "hashes" | "outcome">>;
    for (const { name, result } of clean.tracks) {
      if (
        JSON.stringify({ hashes: result.hashes, outcome: result.outcome }) !==
        JSON.stringify(goldens[name])
      ) {
        throw new Error(`Clean replay disagrees with golden: ${name}`);
      }
    }
    if (
      !clean.canary.outcome.alive ||
      clean.canary.outcome.won ||
      clean.canary.outcome.frame < 1200
    ) {
      throw new Error("Clean canary must stay alive and active for 20 seconds");
    }
    const candidates: Candidate[] = [];
    for (const file of (await readdir(join(ROOT, "packages/sim/src"))).sort()) {
      if (!file.endsWith(".ts") || file === "world.ts") continue;
      const path = join(ROOT, "packages/sim/src", file);
      candidates.push(
        ...(await enumerate(
          await readFile(path, "utf8"),
          relative(ROOT, path),
        )),
      );
    }
    if (!candidates.length) throw new Error("No enumerated candidates");
    const accepted: PooledMutant[] = [];
    const unlearned = new Set(
      eligibleMutants(candidates, digest, await loadRegressions()).map(
        (candidate) => candidate.id,
      ),
    );
    const rejected: { id: string; stage: string; detail: string }[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const path = join(workspace, candidate.file);
      const original = await readFile(path, "utf8");
      let stage = "typecheck";
      try {
        stage = "learned-regression";
        if (!unlearned.has(candidate.id))
          throw new Error(
            "Original mutation is already killed by a credited regression",
          );
        stage = "typecheck";
        await writeFile(path, applyCandidate(original, candidate));
        checkTypes();
        stage = "equivalent";
        if ((await minified(workspace)) === cleanCode)
          throw new Error("Minified code equals clean build");
        stage = "replay-budget";
        const bugged = await execute(workspace, parent);
        const evidence = clean.tracks.map((track, i) => {
          const other = bugged.tracks[i];
          if (!other || other.name !== track.name)
            throw new Error("Missing replay");
          return compareReplay(track.name, track.result, other.result);
        });
        stage = "survived";
        if (!evidence.some((e) => e.failed))
          throw new Error("All replays pass");
        stage = "invisible";
        if (!evidence.some((e) => e.visibleFrame !== null))
          throw new Error("No visible effect within 600 frames");
        stage = "unsurvivable";
        if (
          !bugged.canary.outcome.alive ||
          bugged.canary.outcome.won ||
          bugged.canary.outcome.frame < 1200 ||
          bugged.canary.samples.some((s) => !s.alive || s.won)
        )
          throw new Error("Canary did not survive 1200 active frames");
        accepted.push({
          ...candidate,
          family: operatorFamily(candidate),
          failedReplays: evidence.filter((e) => e.failed).map((e) => e.name),
          evidence,
          gates: {
            typecheck: true,
            differentMinifiedOutput: true,
            killed: true,
            visible: true,
            frameBudget: 3600,
            processBudgetMs: 3000,
            canaryFrames: bugged.canary.outcome.frame,
          },
        });
      } catch (error) {
        rejected.push({ id: candidate.id, stage, detail: String(error) });
      } finally {
        await writeFile(path, original);
      }
      if ((index + 1) % 25 === 0 || index + 1 === candidates.length) {
        console.log(
          `Gated ${index + 1}/${candidates.length}; accepted ${accepted.length}`,
        );
      }
    }
    const missing = FAMILIES.filter(
      (f) =>
        accepted.filter((m) => m.family === f).length <
        (f === "gravity-sign" ||
        f === "swapped-controls" ||
        f === "collision-off-by-one"
          ? 3
          : 1),
    );
    if ((await sourceDigest()) !== digest)
      throw new Error(
        "Source changed during pool generation; rerun against stable inputs",
      );
    await mkdir(join(ROOT, ".local"), { recursive: true });
    await writeFile(
      join(ROOT, ".local/mutation-gate.json"),
      JSON.stringify({ accepted, rejected }, null, 2),
    );
    if (missing.length)
      throw new Error(
        `Missing required families: ${missing.join(", ")}. See .local/mutation-gate.json`,
      );
    const rejectedByStage = Object.fromEntries(
      [...new Set(rejected.map((r) => r.stage))]
        .sort()
        .map((stage) => [
          stage,
          rejected.filter((r) => r.stage === stage).length,
        ]),
    );
    await writeFile(
      join(ROOT, "packages/mutator/pool.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          instrumenterVersion: "9.3.0",
          sourceDigest: digest,
          candidateCount: candidates.length,
          rejectedByStage,
          mutants: accepted,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `Pool saved: ${accepted.length} mutants; all required families present.`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
