import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { applyCandidate } from "../../mutator/src/index.js";
import { TRACKS } from "../../replay/src/index.js";
import { copyDependencies } from "./dependencies.js";
import {
  loadRegressions,
  neutralRegressions,
  REGRESSIONS_DIRECTORY,
  sourceFingerprint,
} from "./regressions.js";

export type Snapshot = Record<string, string>;
export const neutralReplayName = (name: string): string => {
  const index = TRACKS.findIndex((track) => track.name === name);
  if (index < 0) throw new Error("Unknown replay name");
  return `replay-${String(index + 1).padStart(2, "0")}`;
};
export interface TrialWorkspace {
  parent: string;
  game: string;
  home: string;
  initialHead: string;
  before: Snapshot;
  cleanSources: Record<string, string>;
  cleanup: () => Promise<void>;
}

export function git(game: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-C",
      game,
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trim();
}

export async function snapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = {};
  const boundary = `${await realpath(root)}/`;
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const key = prefix ? `${prefix}/${name}` : name;
      // Git's mutable index and Vite's generated caches carry no judged source.
      if (
        key === ".git" ||
        key === ".cache" ||
        key === ".tmp" ||
        key === "node_modules/.vite-temp"
      )
        continue;
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (!(await realpath(path)).startsWith(boundary))
          throw new Error(`Symlink escapes trial workspace: ${key}`);
        result[key] = `link:${await readlink(path)}`;
      } else if (info.isDirectory()) await walk(path, key);
      else if (info.isFile())
        result[key] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      else throw new Error(`Unexpected filesystem entry: ${key}`);
    }
  }
  await walk(root, "");
  return result;
}

export function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((p) => before[p] !== after[p]);
}

export async function inspectChanges(
  game: string,
  before: Snapshot,
): Promise<{ filesChanged: string[]; linesChanged: number }> {
  const filesChanged = changedPaths(before, await snapshot(game));
  let linesChanged = git(game, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--numstat",
    "HEAD",
    "--",
    "src",
  ])
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => {
      const [a, b] = line.split("\t");
      if (!/^\d+$/.test(a ?? "") || !/^\d+$/.test(b ?? ""))
        throw new Error("Nontext source change");
      return sum + Number(a) + Number(b);
    }, 0);
  for (const path of git(game, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "src",
  ])
    .split("\n")
    .filter(Boolean)) {
    const text = await readFile(join(game, path), "utf8");
    linesChanged += text.length
      ? text.split("\n").length - Number(text.endsWith("\n"))
      : 0;
  }
  return { filesChanged, linesChanged };
}

const replayTest = `import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createState, hashState, step } from '../src/index.js';
const tracks = JSON.parse(readFileSync(new URL('../fixtures/tracks.json', import.meta.url), 'utf8'));
const goldens = JSON.parse(readFileSync(new URL('../fixtures/goldens.json', import.meta.url), 'utf8'));
for (const track of tracks) it(track.name, () => {
  let state = createState(track.seed);
  const hashes = [];
  if (!track.inputs.length || track.inputs.length > 3600) throw new Error('frame budget');
  for (const input of track.inputs) {
    state = step(state, input);
    if (![state.x,state.y,state.vx,state.vy].every(Number.isSafeInteger)) throw new Error('noninteger state');
    if (state.frame % 60 === 0) hashes.push({frame:state.frame,hash:hashState(state)});
  }
  const outcome = { frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won };
  expect({hashes,outcome}).toEqual(goldens[track.name]);
});
`;

export async function prepareWorkspace(
  mutant: PooledMutant | null,
  regressionsDirectory = REGRESSIONS_DIRECTORY,
): Promise<TrialWorkspace> {
  const parent = await mkdtemp(join(tmpdir(), "cv-"));
  const game = join(parent, "game");
  const home = await mkdtemp(join(tmpdir(), "cv-home-"));
  const cleanup = async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  try {
    await mkdir(join(game, "test"), { recursive: true });
    await mkdir(join(game, "fixtures"));
    await mkdir(join(game, ".tmp"));
    await cp(join(ROOT, "packages/sim/src"), join(game, "src"), {
      recursive: true,
    });
    await cp(join(ROOT, "packages/sim/test"), join(game, "test"), {
      recursive: true,
    });
    const cleanSources: Record<string, string> = {};
    for (const file of await readdir(join(game, "src")))
      cleanSources[`src/${file}`] = await readFile(
        join(game, "src", file),
        "utf8",
      );
    const regressions = neutralRegressions(
      await loadRegressions(regressionsDirectory),
      sourceFingerprint(cleanSources),
    );
    await writeFile(
      join(game, "fixtures/regressions.json"),
      JSON.stringify(regressions),
    );
    if (regressions.length)
      await writeFile(
        join(game, "test/regressions.test.ts"),
        `import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createState, hashState, step } from '../src/index.js';
const records = JSON.parse(readFileSync(new URL('../fixtures/regressions.json', import.meta.url), 'utf8'));
for (const record of records) it(record.name, () => {
  for (const {track,expected} of record.routes) {
    if (!track.inputs.length || track.inputs.length > 3600) throw new Error('frame budget');
    let state = createState(track.seed); const hashes = []; const checkpoints = [];
    for (const input of track.inputs) {
      state = step(state,input);
      if (![state.x,state.y,state.vx,state.vy].every(Number.isSafeInteger)) throw new Error('noninteger state');
      const hash = hashState(state);
      if (state.frame%60===0) hashes.push({frame:state.frame,hash});
      if (expected.checkpoints.some((point: {frame:number})=>point.frame===state.frame)) checkpoints.push({frame:state.frame,hash});
    }
    const outcome = {frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won};
    expect({hashes,outcome,checkpoints}).toEqual(expected);
  }
});
`,
      );
    if (mutant) {
      const localFile = mutant.file.replace(/^packages\/sim\//, "");
      if (!localFile.startsWith("src/") || localFile.includes(".."))
        throw new Error("Invalid mutant source path");
      const source = cleanSources[localFile];
      if (!source) throw new Error("Missing mutant source");
      await writeFile(join(game, localFile), applyCandidate(source, mutant));
    }
    await writeFile(join(game, "test/replay.test.ts"), replayTest);
    await writeFile(
      join(game, "fixtures/tracks.json"),
      JSON.stringify(
        TRACKS.map((track) => ({
          ...track,
          name: neutralReplayName(track.name),
        })),
      ),
    );
    const goldens = JSON.parse(
      await readFile(
        join(ROOT, "packages/replay/fixtures/goldens.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    await writeFile(
      join(game, "fixtures/goldens.json"),
      JSON.stringify(
        Object.fromEntries(
          TRACKS.map((track) => [
            neutralReplayName(track.name),
            goldens[track.name],
          ]),
        ),
      ),
    );
    await writeFile(
      join(game, "package.json"),
      JSON.stringify(
        {
          name: "game",
          private: true,
          type: "module",
          engines: { node: "22.x" },
          scripts: {
            test: "node node_modules/vitest/vitest.mjs run",
            typecheck: "node node_modules/typescript/bin/tsc --noEmit",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(game, "vitest.config.mjs"),
      `export default {cacheDir:'.cache/vite',test:{include:['test/**/*.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:2000,cache:false}};\n`,
    );
    await writeFile(
      join(game, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            types: ["node"],
            lib: ["ES2022"],
            noEmit: true,
          },
          include: ["src/**/*.ts", "test/**/*.ts"],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(game, ".gitignore"),
      "node_modules/\n.cache/\n.tmp/\n",
    );
    await copyDependencies(game, ROOT);
    git(game, ["init", "-b", "main"]);
    git(game, [
      "add",
      "src",
      "test",
      "fixtures",
      "package.json",
      "tsconfig.json",
      "vitest.config.mjs",
      ".gitignore",
    ]);
    git(game, [
      "-c",
      "user.name=Stephen Sookra",
      "-c",
      "user.email=stephensookra@gmail.com",
      "commit",
      "-m",
      "Initial game",
    ]);
    const initialHead = git(game, ["rev-parse", "HEAD"]);
    if (git(game, ["rev-list", "--count", "HEAD"]) !== "1")
      throw new Error("Trial history must contain one commit");
    if ((await readdir(parent)).join() !== "game")
      throw new Error("Trial parent has siblings");
    return {
      parent: await realpath(parent),
      game: await realpath(game),
      home,
      initialHead,
      before: await snapshot(game),
      cleanSources,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
