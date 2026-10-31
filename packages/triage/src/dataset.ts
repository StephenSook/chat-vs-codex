import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import {
  authorizedRegions,
  type HotfixManifest,
} from "../../hotfix-ready/src/manifest.js";
import type { PooledMutant } from "../../mutator/src/gate.js";
import { applyCandidate } from "../../mutator/src/index.js";
import { FEATURE_NAMES, replayFeatures, type TriageFrame } from "./features.js";
export interface TriageRow {
  game: "platformer" | "breakout";
  mutantId: string;
  family: string;
  /** Full named mutation region, not candidate ID or individual mutated expression. */
  site: string;
  features: number[];
}
export interface TriageDataset {
  schemaVersion: 1;
  features: readonly string[];
  featureExtractorDigest: string;
  poolDigests: Record<string, string>;
  rows: TriageRow[];
}
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export async function featureExtractorDigest(): Promise<string> {
  return sha256(await readFile(new URL("./features.ts", import.meta.url)));
}
export async function collectDataset(root: string): Promise<TriageDataset> {
  root = resolve(root);
  const scratch = await mkdtemp(join(tmpdir(), "triage-telemetry-"));
  const result: TriageDataset = {
    schemaVersion: 1,
    features: FEATURE_NAMES,
    featureExtractorDigest: await featureExtractorDigest(),
    poolDigests: {},
    rows: [],
  };
  try {
    for (const game of ["platformer", "breakout"] as const) {
      const poolText = await readFile(
        join(
          root,
          game === "platformer"
            ? "packages/mutator/pool.json"
            : "games/breakout/pool.json",
        ),
        "utf8",
      );
      const pool = JSON.parse(poolText) as { mutants: PooledMutant[] };
      result.poolDigests[game] = sha256(poolText);
      const sourceRoot =
        game === "platformer" ? root : join(root, "games/breakout");
      for (const mutant of pool.mutants) {
        const target = join(sourceRoot, mutant.file);
        const original = await readFile(target, "utf8");
        const manifest =
          game === "breakout"
            ? (JSON.parse(
                await readFile(join(sourceRoot, "hotfix-sites.json"), "utf8"),
              ) as HotfixManifest)
            : null;
        const binding = manifest?.files.find((f) => f.file === mutant.file);
        const source = applyCandidate(
          original,
          mutant,
          binding ? authorizedRegions(original, binding) : undefined,
        );
        const outfile = join(scratch, "capture.mjs");
        const sim = join(
          root,
          game === "platformer"
            ? "packages/sim/src/index.ts"
            : "games/breakout/src/index.ts",
        );
        const tracks = join(
          root,
          game === "platformer"
            ? "packages/replay/src/index.ts"
            : "games/breakout/tracks.ts",
        );
        await build({
          stdin: {
            loader: "ts",
            resolveDir: root,
            contents: `import{createState,step}from${JSON.stringify(sim)};import{TRACKS}from${JSON.stringify(tracks)};console.log(JSON.stringify(TRACKS.map(track=>{if(track.inputs.length>3600)throw Error('frame budget');let s=createState(track.seed);const f=(input,previous)=>({frame:s.frame,input,x:s.x,y:s.y,vx:s.vx,vy:s.vy,responseVx:s.paddle===undefined?s.vx:previous?s.paddle-previous.paddle:0,alive:s.alive,contact:Boolean(s.grounded??(previous&&(s.vx*previous.vx<0||s.vy*previous.vy<0))),enemyTurns:s.enemy?.turns??0});const out=[f(null,null)];for(const input of track.inputs){const previous=s;s=step(s,input);out.push(f(input,previous))}return out})));`,
          },
          outfile,
          bundle: true,
          format: "esm",
          platform: "node",
          target: "node22",
          plugins: [
            {
              name: "one-original-mutant",
              setup(builder) {
                builder.onLoad({ filter: /\.(?:ts|js)$/ }, (args) =>
                  args.path === target
                    ? { contents: source, loader: "ts" }
                    : undefined,
                );
              },
            },
          ],
        });
        const capture = spawnSync(process.execPath, [outfile], {
          cwd: scratch,
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
          maxBuffer: 16 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            TMPDIR: scratch,
            TMP: scratch,
            TEMP: scratch,
          },
        });
        if (capture.error || capture.signal || capture.status !== 0)
          throw new Error(`Telemetry capture failed for ${game}:${mutant.id}`);
        const frames = JSON.parse(capture.stdout) as TriageFrame[][];
        result.rows.push({
          game,
          mutantId: mutant.id,
          family: `${game}:${mutant.family}`,
          site: `${game}:${mutant.file}:${mutant.site}`,
          features: replayFeatures(frames),
        });
      }
    }
    return result;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function writeDataset(root: string): Promise<TriageDataset> {
  const data = await collectDataset(root);
  await writeFile(
    join(root, "bench/triage/dataset.json"),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  return data;
}
