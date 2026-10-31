import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_OUT, runTrack, TRACKS } from "../../../games/breakout/replay.js";
import {
  authorizedRegions,
  type HotfixManifest,
} from "../../hotfix-ready/src/manifest.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { applyCandidate } from "../../mutator/src/index.js";
import { copyDependencies } from "./dependencies.js";
import { git, snapshot, type TrialWorkspace } from "./workspace.js";

const directory = join(ROOT, "games/breakout");
export function adapterHeldOut(): {
  track: typeof HELD_OUT;
  expected: unknown;
} {
  const { hashes, outcome } = runTrack(HELD_OUT);
  return { track: HELD_OUT, expected: { hashes, outcome } };
}
export async function prepareAdapterWorkspace(
  mutant: PooledMutant | null,
): Promise<TrialWorkspace> {
  const parent = await mkdtemp(join(tmpdir(), "cv-"));
  const game = join(parent, "game");
  const home = await mkdtemp(join(tmpdir(), "cv-home-"));
  const cleanup = async () => {
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  };
  try {
    for (const folder of ["test", "fixtures", ".tmp"])
      await mkdir(join(game, folder), { recursive: true });
    await cp(join(directory, "src"), join(game, "src"), { recursive: true });
    const cleanSources: Record<string, string> = {};
    for (const file of await readdir(join(game, "src")))
      cleanSources[`src/${file}`] = await readFile(
        join(game, "src", file),
        "utf8",
      );
    if (mutant) {
      const manifest = JSON.parse(
        await readFile(join(directory, "hotfix-sites.json"), "utf8"),
      ) as HotfixManifest;
      const binding = manifest.files.find((file) => file.file === mutant.file);
      const source = cleanSources[mutant.file];
      if (!binding || source === undefined)
        throw new Error("Unknown sidecar mutation source");
      await writeFile(
        join(game, mutant.file),
        applyCandidate(source, mutant, authorizedRegions(source, binding)),
      );
    }
    await writeFile(join(game, "fixtures/tracks.json"), JSON.stringify(TRACKS));
    const goldens = Object.fromEntries(
      TRACKS.map((track) => {
        const { hashes, outcome } = runTrack(track);
        return [track.name, { hashes, outcome }];
      }),
    );
    await writeFile(
      join(game, "fixtures/goldens.json"),
      JSON.stringify(goldens),
    );
    await writeFile(
      join(game, "test/replay.test.ts"),
      `import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';import {createState,step,hashState} from '../src/index.js';
const tracks=JSON.parse(readFileSync(new URL('../fixtures/tracks.json',import.meta.url),'utf8'));
const goldens=JSON.parse(readFileSync(new URL('../fixtures/goldens.json',import.meta.url),'utf8'));
for(const track of tracks) it(track.name,()=>{if(!track.inputs.length || track.inputs.length>3600)throw new Error('frame budget');let state=createState(track.seed);const hashes=[];for(const input of track.inputs){state=step(state,input);if(![state.x,state.y,state.vx,state.vy,state.paddle].every(Number.isSafeInteger))throw new Error('noninteger state');if(state.frame%60===0)hashes.push({frame:state.frame,hash:hashState(state)});}const outcome={frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won};expect({hashes,outcome}).toEqual(goldens[track.name]);});`,
    );
    await writeFile(
      join(game, "package.json"),
      JSON.stringify({
        name: "game",
        private: true,
        type: "module",
        engines: { node: "22.x" },
        scripts: { test: "node node_modules/vitest/vitest.mjs run" },
      }),
    );
    await writeFile(
      join(game, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
          lib: ["ES2022"],
        },
        include: ["src/**/*.ts", "test/**/*.ts"],
      }),
    );
    await writeFile(
      join(game, "vitest.config.mjs"),
      `export default {cacheDir:'.cache/vite',test:{include:['test/**/*.test.ts'],maxWorkers:1,fileParallelism:false,testTimeout:2000,cache:false}};`,
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
    if (
      git(game, ["rev-list", "--count", "HEAD"]) !== "1" ||
      (await readdir(parent)).join() !== "game"
    )
      throw new Error("Invalid trial isolation");
    return {
      parent: await realpath(parent),
      game: await realpath(game),
      home,
      initialHead: git(game, ["rev-parse", "HEAD"]),
      before: await snapshot(game),
      cleanSources,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
