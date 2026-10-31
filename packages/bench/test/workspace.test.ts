import { spawnSync } from "node:child_process";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { HELD_OUT } from "../../replay/src/index.js";
import { buildTicket } from "../src/trial.js";
import {
  changedPaths,
  git,
  prepareWorkspace,
  snapshot,
} from "../src/workspace.js";

it("creates a neutral isolated mutated repo with one commit and self-contained tests", async () => {
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { mutants: PooledMutant[] };
  const mutant = pool.mutants.find((m) => m.family === "gravity-sign");
  if (!mutant) throw new Error("No gravity candidate");
  const workspace = await prepareWorkspace(mutant);
  try {
    expect(await readdir(workspace.parent)).toEqual(["game"]);
    expect(await readdir(workspace.home)).toEqual([]);
    expect(git(workspace.game, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(workspace.game, ["status", "--porcelain"])).toBe("");
    expect(
      await realpath(join(workspace.game, "node_modules/pure-rand")),
    ).toMatch(`${workspace.game}/`);
    const tracks = await readFile(
      join(workspace.game, "fixtures/tracks.json"),
      "utf8",
    );
    expect(tracks).not.toContain(HELD_OUT.name);
    expect(tracks).not.toContain("enemy-ledge-patrol");
    expect(buildTicket(mutant)).not.toContain(mutant.id);
    expect(buildTicket(mutant)).not.toContain(mutant.family);
    expect(buildTicket(mutant)).not.toContain(mutant.file);
    expect(buildTicket(mutant)).toContain("replay-01");
    const run = () =>
      spawnSync(
        process.execPath,
        [join(workspace.game, "node_modules/vitest/vitest.mjs"), "run"],
        {
          cwd: workspace.game,
          encoding: "utf8",
          timeout: 10000,
        },
      );
    const broken = run();
    expect(broken.error).toBeUndefined();
    expect(broken.status, broken.stdout + broken.stderr).toBe(1);
    expect(broken.stdout + broken.stderr).toContain("replay-01");
    // This unit-test workspace is never sent to a runtime. Prove its verifier can pass too.
    for (const [path, source] of Object.entries(workspace.cleanSources))
      await writeFile(join(workspace.game, path), source);
    const fixed = run();
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0);
    const changes = changedPaths(
      workspace.before,
      await snapshot(workspace.game),
    );
    expect(changes).toContain("src/index.ts");
    expect(changes.every((path) => path.startsWith("src/"))).toBe(true);
    const typecheck = spawnSync(
      process.execPath,
      [join(workspace.game, "node_modules/typescript/bin/tsc"), "--noEmit"],
      {
        cwd: workspace.game,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 30000);
