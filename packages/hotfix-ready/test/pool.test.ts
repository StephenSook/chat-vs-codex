import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../mutator/src/gate.js";
import { applyCandidate } from "../../mutator/src/index.js";
import { type GatePool, sourcesDigest } from "../src/gate.js";
import { authorizedRegions, type HotfixManifest } from "../src/manifest.js";

it("binds the complete second-game pool to unchanged sidecar-authorized source and all gates", async () => {
  const directory = join(ROOT, "games/breakout");
  const pool = JSON.parse(
    await readFile(join(directory, "pool.json"), "utf8"),
  ) as GatePool;
  const manifest = JSON.parse(
    await readFile(join(directory, "hotfix-sites.json"), "utf8"),
  ) as HotfixManifest;
  expect(pool.sourceDigest).toBe(await sourcesDigest(directory));
  expect(pool.mutants.length).toBeGreaterThanOrEqual(3);
  expect(
    pool.mutants.length +
      Object.values(pool.rejected).reduce((n, count) => n + count, 0),
  ).toBe(pool.enumerated);
  for (const mutant of pool.mutants) {
    const binding = manifest.files.find((file) => file.file === mutant.file);
    if (!binding) throw new Error("Unknown mutation source");
    const source = await readFile(join(directory, mutant.file), "utf8");
    expect(
      applyCandidate(source, mutant, authorizedRegions(source, binding)),
    ).not.toBe(source);
    expect(mutant.gates).toMatchObject({
      typecheck: true,
      differentMinifiedOutput: true,
      killed: true,
      visible: true,
      canaryFrames: 1200,
    });
    expect(mutant.gates.processBudgetMs).toBeLessThanOrEqual(5000);
    expect(
      mutant.evidence.some(
        (row) =>
          row.failed && row.visibleFrame !== null && row.visibleFrame <= 600,
      ),
    ).toBe(true);
  }
});
