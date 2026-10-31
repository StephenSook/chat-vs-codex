import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import {
  ENEMY_FIELDS,
  type InspectorData,
  PLAYER_FIELDS,
  parseInspectorData,
  telemetryFrame,
} from "../../inspector-mcp/src/index.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { applyCandidate } from "../../mutator/src/index.js";
import { TRACKS } from "../../replay/src/index.js";
import { createState, step } from "../../sim/src/index.js";
import { confinedBundlePlugin } from "./confined-bundle.js";

/** Before the initial commit and before the SDK, run only the trusted pooled mutant.
 * This bounded offline capture is never used to execute Codex-authored patches. */
export async function materializeInspector(
  game: string,
  mutant: PooledMutant | null,
): Promise<void> {
  if (mutant) {
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    if (
      !pool.mutants.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(mutant),
      )
    )
      throw new Error("Inspector requires a trusted pooled original mutant");
  }
  for (const file of ["index.ts", "world.ts"]) {
    const clean = await readFile(join(ROOT, "packages/sim/src", file), "utf8");
    const expected =
      mutant?.file === `packages/sim/src/${file}`
        ? applyCandidate(clean, mutant)
        : clean;
    if ((await readFile(join(game, "src", file), "utf8")) !== expected)
      throw new Error("Inspector accepts only the original planted source");
  }
  const tracks = TRACKS.map((track, index) => ({
    ...track,
    name: `replay-${String(index + 1).padStart(2, "0")}`,
  }));
  const runner = join(game, ".tmp/inspector-capture.mjs");
  try {
    await build({
      stdin: {
        contents: `import { createState,step } from ${JSON.stringify(join(game, "src/index.ts"))};
const tracks=${JSON.stringify(tracks)};const playerKeys=${JSON.stringify(PLAYER_FIELDS)};const enemyKeys=${JSON.stringify(ENEMY_FIELDS)};
const frame=(state,input)=>({frame:state.frame,input,player:Object.fromEntries(playerKeys.map(key=>[key,state[key]])),enemy:Object.fromEntries(enemyKeys.map(key=>[key,state.enemy[key]]))});
console.log(JSON.stringify(tracks.map(track=>{let state=createState(track.seed);const frames=[frame(state,null)];for(const input of track.inputs){state=step(state,input);frames.push(frame(state,input));}return frames;})));`,
        loader: "ts",
        resolveDir: game,
      },
      outfile: runner,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      plugins: [confinedBundlePlugin(game)],
    });
    const result = spawnSync(process.execPath, [runner], {
      cwd: game,
      timeout: 3000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: game,
        TMPDIR: join(game, ".tmp"),
        TMP: join(game, ".tmp"),
        TEMP: join(game, ".tmp"),
      },
    });
    if (result.error || result.signal || result.status !== 0)
      throw new Error(
        "Original visible replay capture failed or exceeded its frame budget",
      );
    const buggy = JSON.parse(result.stdout) as unknown[];
    if (!Array.isArray(buggy) || buggy.length !== tracks.length)
      throw new Error("Missing visible replay telemetry");
    const data = parseInspectorData({
      schemaVersion: 1,
      fps: 60,
      units: "Q8",
      tracks: tracks.map((track, index) => {
        let state = createState(track.seed);
        const golden = [telemetryFrame(state, null)];
        for (const input of track.inputs) {
          state = step(state, input);
          golden.push(telemetryFrame(state, input));
        }
        return { name: track.name, golden, buggy: buggy[index] };
      }),
    } satisfies Omit<InspectorData, "tracks"> & { tracks: unknown[] });
    const fixtures = join(game, "fixtures/inspector");
    await mkdir(fixtures);
    await writeFile(join(fixtures, "traces.json"), JSON.stringify(data));
    await build({
      entryPoints: [join(ROOT, "packages/inspector-mcp/src/server.ts")],
      outfile: join(fixtures, "server.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: false,
      legalComments: "none",
    });
  } finally {
    await rm(runner, { force: true });
  }
}
