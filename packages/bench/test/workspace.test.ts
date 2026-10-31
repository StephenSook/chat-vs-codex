import { spawnSync } from "node:child_process";
import {
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
import { expect, it, vi } from "vitest";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { HELD_OUT } from "../../replay/src/index.js";
import { captureRegression, persistRegression } from "../src/regressions.js";
import { runtimeEnvironment } from "../src/runtime.js";
import { buildTicket } from "../src/trial.js";
import {
  changedPaths,
  git,
  prepareWorkspace,
  snapshot,
} from "../src/workspace.js";

it("keeps trial Git isolated from inherited publishing repository selectors", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "isolated-git-"));
  try {
    vi.stubEnv("GIT_DIR", join(scratch, "absent-publisher"));
    vi.stubEnv("GIT_WORK_TREE", join(scratch, "absent-tree"));
    vi.stubEnv("GIT_INDEX_FILE", join(scratch, "absent-index"));
    git(scratch, ["init", "--quiet"]);
    expect(await readdir(scratch)).toContain(".git");
    expect(git(scratch, ["rev-parse", "--show-toplevel"])).toBe(
      await realpath(scratch),
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(scratch, { recursive: true, force: true });
  }
});

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
    expect(await readdir(join(workspace.game, ".tmp"))).toEqual([]);
    expect(git(workspace.game, ["show", "HEAD:.gitignore"])).toContain(".tmp/");
    await mkdir(join(workspace.game, ".tmp/ssr"));
    await writeFile(join(workspace.game, ".tmp/ssr/cache.js"), "cache");
    expect(
      changedPaths(workspace.before, await snapshot(workspace.game)),
    ).toEqual([]);
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
          env: runtimeEnvironment(workspace.game, workspace.home),
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
        env: runtimeEnvironment(workspace.game, workspace.home),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(typecheck.status, typecheck.stdout + typecheck.stderr).toBe(0);
  } finally {
    await workspace.cleanup();
  }
}, 30000);

it("puts one credited round into the initial immutable suite and proves clean pass plus original-mutant kill", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "grown-workspace-"));
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { sourceDigest: string; mutants: PooledMutant[] };
  const mutant = pool.mutants.find(
    (item) => item.family === "collision-off-by-one",
  );
  if (!mutant) throw new Error("Missing regression fixture");
  const proofWorkspace = await prepareWorkspace(mutant, scratch);
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
  try {
    const proof = await captureRegression(
      proofWorkspace,
      mutant,
      pool.sourceDigest,
    );
    const roundId = "00000000-0000-0000-0000-000000000002";
    await persistRegression(scratch, proof, {
      roundId,
      viewer: "viewer-cccccccccccccccc",
    });
    workspace = await prepareWorkspace(mutant, scratch);
    expect(git(workspace.game, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(workspace.game, ["status", "--porcelain"])).toBe("");
    expect(
      git(workspace.game, ["show", "HEAD:fixtures/regressions.json"]),
    ).toContain("regression-0001");
    const fixture = await readFile(
      join(workspace.game, "fixtures/regressions.json"),
      "utf8",
    );
    for (const secret of [
      mutant.id,
      "collision-off-by-one",
      roundId,
      "viewer-cccccccccccccccc",
      "canary",
      "witness",
    ])
      expect(fixture).not.toContain(secret);
    expect(JSON.parse(fixture)).toHaveLength(1);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          join(workspace?.game ?? "", "node_modules/vitest/vitest.mjs"),
          "run",
          "test/regressions.test.ts",
        ],
        {
          cwd: workspace?.game,
          env: runtimeEnvironment(workspace?.game ?? "", workspace?.home ?? ""),
          timeout: 10000,
          encoding: "utf8",
        },
      );
    const broken = run();
    expect(broken.error).toBeUndefined();
    expect(broken.status, broken.stdout + broken.stderr).toBe(1);
    expect(broken.stdout + broken.stderr).toContain("regression-0001");
    for (const [path, source] of Object.entries(workspace.cleanSources))
      await writeFile(join(workspace.game, path), source);
    const clean = run();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain("1 passed");
    expect(
      changedPaths(workspace.before, await snapshot(workspace.game)),
    ).toEqual(["src/index.ts"]);
    const file = join(workspace.game, "fixtures/regressions.json");
    await readFile(file, "utf8");
    await writeFile(file, "[]");
    expect(
      changedPaths(workspace.before, await snapshot(workspace.game)),
    ).toContain("fixtures/regressions.json");
  } finally {
    await workspace?.cleanup();
    await proofWorkspace.cleanup();
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);
