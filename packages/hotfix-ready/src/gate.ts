import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { compareReplay } from "../../mutator/src/evidence.js";
import type { PooledMutant } from "../../mutator/src/gate.js";
import {
  applyCandidate,
  type Candidate,
  enumerate,
} from "../../mutator/src/index.js";
import { runBounded } from "../../mutator/src/process.js";
import { parseGateOutput } from "./evidence.js";
import { authorizedRegions, digest, type HotfixManifest } from "./manifest.js";
export interface GatePool {
  schemaVersion: 1;
  game: string;
  sourceDigest: string;
  enumerated: number;
  mutants: PooledMutant[];
  rejected: Record<string, number>;
}
export async function sourcesDigest(directory: string): Promise<string> {
  const entries: [string, string][] = [];
  async function walk(path: string, prefix: string): Promise<void> {
    for (const file of (await readdir(path)).sort()) {
      const local = join(path, file);
      const key = prefix ? `${prefix}/${file}` : file;
      if (!(await lstat(local)).isFile())
        throw new Error(
          "Only flat, regular source files are supported; symlinks are refused",
        );
      if (file.endsWith(".ts") || file.endsWith(".js"))
        entries.push([key, await readFile(local, "utf8")]);
    }
  }
  await walk(join(directory, "src"), "src");
  for (const path of ["tracks.ts", "replay.ts", "hotfix-sites.json"])
    entries.push([path, await readFile(join(directory, path), "utf8")]);
  return digest(JSON.stringify(entries));
}
export async function gatePool(
  directory: string,
  toolingRoot: string,
): Promise<GatePool> {
  directory = resolve(directory);
  toolingRoot = resolve(toolingRoot);
  const manifest = JSON.parse(
    await readFile(join(directory, "hotfix-sites.json"), "utf8"),
  ) as HotfixManifest;
  if (manifest.schemaVersion !== 1 || !manifest.files.length)
    throw new Error("No authorized sidecar sites");
  const sourceDigest = await sourcesDigest(directory);
  const candidates: Candidate[] = [];
  for (const file of manifest.files) {
    if (!/^src\/[a-zA-Z0-9_-]+\.(?:ts|js)$/.test(file.file))
      throw new Error("Unsupported sidecar source path");
    const source = await readFile(join(directory, file.file), "utf8");
    candidates.push(
      ...(await enumerate(source, file.file, authorizedRegions(source, file))),
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), "hotfix-gate-"));
  const pool: GatePool = {
    schemaVersion: 1,
    game: directory.split("/").at(-1) ?? "game",
    sourceDigest,
    enumerated: candidates.length,
    mutants: [],
    rejected: {},
  };
  try {
    await cp(join(directory, "src"), join(scratch, "src"), { recursive: true });
    for (const file of ["tracks.ts", "replay.ts"])
      await cp(join(directory, file), join(scratch, file));
    await writeFile(
      join(scratch, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
          checkJs: true,
        },
        include: ["src/**/*", "tracks.ts", "replay.ts"],
      }),
    );
    await mkdir(join(scratch, "node_modules"));
    for (const name of ["pure-rand"])
      await symlink(
        join(toolingRoot, "packages/sim/node_modules", name),
        join(scratch, "node_modules", name),
        "dir",
      );
    const clean = new Map(
      await Promise.all(
        manifest.files.map(
          async (file) =>
            [
              file.file,
              await readFile(join(directory, file.file), "utf8"),
            ] as const,
        ),
      ),
    );
    const runner = join(scratch, "run.mjs");
    async function evidence(): Promise<ReturnType<typeof parseGateOutput>> {
      await build({
        stdin: {
          contents:
            'import{gateEvidence}from"./replay.ts";import{TRACKS}from"./tracks.ts";console.log(JSON.stringify({definitions:TRACKS,evidence:gateEvidence()}));',
          resolveDir: scratch,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: runner,
      });
      return parseGateOutput(
        JSON.parse(runBounded(process.execPath, [runner], scratch, 3000)),
      );
    }
    const sourceFiles = await readdir(join(scratch, "src"));
    const entryPoints = ["src/index.ts", "src/index.js"].filter((file) =>
      sourceFiles.includes(file.slice(4)),
    );
    if (entryPoints.length !== 1)
      throw new Error(
        "Expected exactly one sidecar-bound src/index.ts or src/index.js entry point",
      );
    async function minified(): Promise<string> {
      const result = await build({
        entryPoints: [join(scratch, entryPoints[0] ?? "")],
        bundle: true,
        platform: "node",
        format: "esm",
        minify: true,
        write: false,
      });
      return result.outputFiles[0]?.text ?? "";
    }
    runBounded(
      process.execPath,
      [join(toolingRoot, "node_modules/typescript/bin/tsc"), "--noEmit"],
      scratch,
      5000,
    );
    const baselineOutput = await evidence();
    const repeated = await evidence();
    if (JSON.stringify(baselineOutput) !== JSON.stringify(repeated))
      throw new Error(
        "Clean replay is not deterministic; no candidate was gated",
      );
    const baseline = baselineOutput.evidence;
    if (
      !baseline.canary.alive ||
      baseline.canary.won ||
      baseline.canary.frames !== 1200
    )
      throw new Error("Clean canary does not survive 20 seconds");
    const cleanMinified = await minified();
    for (const candidate of candidates) {
      const source = clean.get(candidate.file);
      if (source === undefined) throw new Error("Missing candidate source");
      const site = manifest.files.find((file) => file.file === candidate.file);
      if (!site) throw new Error("Unknown manifest file");
      let stage = "typecheck";
      try {
        await writeFile(
          join(scratch, candidate.file),
          applyCandidate(source, candidate, authorizedRegions(source, site)),
        );
        runBounded(
          process.execPath,
          [join(toolingRoot, "node_modules/typescript/bin/tsc"), "--noEmit"],
          scratch,
          5000,
        );
        stage = "equivalent";
        if ((await minified()) === cleanMinified)
          throw new Error("Equivalent minification");
        stage = "frame-budget";
        const output = await evidence();
        if (
          JSON.stringify(output.definitions) !==
          JSON.stringify(baselineOutput.definitions)
        )
          throw new Error("Mutation changed replay inputs");
        const bugged = output.evidence;
        if (
          bugged.tracks.some((track) => track.samples.length !== 600) ||
          bugged.canary.frames > 1200
        )
          throw new Error("Frame budget");
        const evidenceRows = baseline.tracks.map((track, index) => {
          const changed = bugged.tracks[index];
          if (!changed) throw new Error("Missing track");
          const row = compareReplay(track.name, track, changed);
          return {
            ...row,
            symptom:
              row.visibleFrame === null
                ? null
                : "The ball leaves its expected path or drops below the playfield.",
          };
        });
        stage = "not-killed";
        if (!evidenceRows.some((row) => row.failed))
          throw new Error("Surviving mutation");
        stage = "invisible";
        if (!evidenceRows.some((row) => row.visibleFrame !== null))
          throw new Error("Invisible mutation");
        stage = "unsurvivable";
        if (
          !bugged.canary.alive ||
          bugged.canary.won ||
          bugged.canary.frames !== 1200
        )
          throw new Error("Canary died");
        pool.mutants.push({
          ...candidate,
          family: candidate.site,
          failedReplays: evidenceRows
            .filter((row) => row.failed)
            .map((row) => row.name),
          evidence: evidenceRows,
          gates: {
            typecheck: true,
            differentMinifiedOutput: true,
            killed: true,
            visible: true,
            frameBudget: 3600,
            processBudgetMs: 3000,
            canaryFrames: bugged.canary.frames,
          },
        });
      } catch {
        pool.rejected[stage] = (pool.rejected[stage] ?? 0) + 1;
      } finally {
        await writeFile(join(scratch, candidate.file), source);
      }
    }
    return pool;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
