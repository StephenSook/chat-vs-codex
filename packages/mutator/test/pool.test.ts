import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FAMILIES,
  operatorFamily,
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../src/gate.js";
import { applyCandidate, type Candidate } from "../src/index.js";

interface Pool {
  sourceDigest: string;
  candidateCount: number;
  rejectedByStage: Record<string, number>;
  mutants: PooledMutant[];
}

describe("mutation pool", () => {
  it("classifies only inclusivity changes as collision off-by-one", () => {
    const base: Candidate = {
      id: "test",
      file: "index.ts",
      site: "collision",
      mutator: "EqualityOperator",
      original: "column <= maxX",
      replacement: "column < maxX",
      location: { start: { line: 0, column: 0 }, end: { line: 0, column: 14 } },
    };
    expect(operatorFamily(base)).toBe("collision-off-by-one");
    expect(operatorFamily({ ...base, replacement: "column > maxX" })).toBe(
      "other",
    );
    expect(
      operatorFamily({
        ...base,
        original: "a.x < b.x + b.width",
        replacement: "a.x >= b.x + b.width",
      }),
    ).toBe("other");
  });

  it("binds nonempty, fully gated evidence to the current sources", async () => {
    const pool = JSON.parse(
      await readFile(`${ROOT}/packages/mutator/pool.json`, "utf8"),
    ) as Pool;
    expect(pool.sourceDigest).toBe(await sourceDigest());
    expect(pool.mutants.length).toBeGreaterThanOrEqual(3);
    expect(pool.candidateCount).toBe(
      pool.mutants.length +
        Object.values(pool.rejectedByStage).reduce((a, b) => a + b, 0),
    );
    for (const family of FAMILIES)
      expect(pool.mutants.some((m) => m.family === family)).toBe(true);
    for (const mutant of pool.mutants) {
      expect(mutant.file).not.toContain("world.ts");
      expect(operatorFamily(mutant)).toBe(mutant.family);
      expect(mutant.gates).toMatchObject({
        typecheck: true,
        differentMinifiedOutput: true,
        killed: true,
        visible: true,
      });
      expect(mutant.gates.canaryFrames).toBeGreaterThanOrEqual(1200);
      expect(mutant.failedReplays.length).toBeGreaterThan(0);
      expect(
        mutant.evidence.some(
          (e) => e.visibleFrame !== null && e.visibleFrame <= 600,
        ),
      ).toBe(true);
      expect(
        mutant.evidence.filter((e) => e.failed).map((e) => e.name),
      ).toEqual(mutant.failedReplays);
      const source = await readFile(`${ROOT}/${mutant.file}`, "utf8");
      expect(applyCandidate(source, mutant)).not.toBe(source);
    }
  });
});
