import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { runTrack, TRACKS } from "../../replay/src/index.js";
import { compareReplay, type ReplayResult } from "../src/evidence.js";
import { FAMILIES, type PooledMutant, ROOT } from "../src/gate.js";
import { applyCandidate } from "../src/index.js";
import { runBounded } from "../src/process.js";

it("independently executes each required family against the replays and canary", async () => {
  const pool = JSON.parse(
    await readFile(`${ROOT}/packages/mutator/pool.json`, "utf8"),
  ) as { mutants: PooledMutant[] };
  const scratch = await mkdtemp(join(tmpdir(), "pool-verification-"));
  try {
    for (const family of FAMILIES) {
      const mutant = pool.mutants.find((m) => m.family === family);
      if (!mutant) throw new Error(`Missing ${family}`);
      const changed = applyCandidate(
        await readFile(`${ROOT}/${mutant.file}`, "utf8"),
        mutant,
      );
      let loadedMutant = false;
      const outfile = join(scratch, "run.mjs");
      await build({
        stdin: {
          contents: `
          import { CANARY, TRACKS, runTrack } from ${JSON.stringify(`${ROOT}/packages/replay/src/index.ts`)};
          console.log(JSON.stringify({ tracks: TRACKS.map(t => runTrack(t)), canary: runTrack(CANARY) }));
        `,
          resolveDir: ROOT,
          loader: "ts",
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        plugins: [
          {
            name: "verify-exact-splice",
            setup(builder) {
              builder.onLoad(
                { filter: /packages\/sim\/src\/index\.ts$/ },
                () => {
                  loadedMutant = true;
                  return { contents: changed, loader: "ts" };
                },
              );
            },
          },
        ],
      });
      expect(loadedMutant).toBe(true);
      const actual = JSON.parse(
        runBounded(process.execPath, [outfile], scratch, 3000),
      ) as {
        tracks: ReplayResult[];
        canary: ReplayResult;
      };
      const evidence = TRACKS.map((track, i) => {
        const bugged = actual.tracks[i];
        if (!bugged) throw new Error("Missing replay result");
        return compareReplay(track.name, runTrack(track), bugged);
      });
      expect(evidence).toEqual(mutant.evidence);
      expect(actual.canary.samples).toHaveLength(1200);
      expect(actual.canary.samples.every((s) => s.alive && !s.won)).toBe(true);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
