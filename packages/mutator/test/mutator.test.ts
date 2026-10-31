import { describe, expect, it } from "vitest";
import { applyCandidate, enumerate, offsetAt, regions } from "../src/index.js";

describe("Stryker enumeration and single splices", () => {
  const source = [
    'const world = "unchanged";',
    "// @hotfix-site physics",
    "export const gravity = 10 + 2;",
    "// @hotfix-site-end physics",
    "export const untouched = 5 + 4;",
    "",
  ].join("\n");

  it("pins Stryker locations to zero-based lines and columns, end exclusive", async () => {
    const candidates = await enumerate(source, "physics.ts");
    const mutant = candidates.find(
      (m) => m.original === "10 + 2" && m.replacement === "10 - 2",
    );
    expect(mutant).toBeDefined();
    expect(mutant?.location).toEqual({
      start: { line: 2, column: 23 },
      end: { line: 2, column: 29 },
    });
    if (!mutant) throw new Error("Expected arithmetic candidate");
    expect(applyCandidate(source, mutant)).toBe(
      source.replace("10 + 2", "10 - 2"),
    );
    expect(candidates.every((m) => m.location.start.line === 2)).toBe(true);
  });

  it("handles CRLF and UTF-16 columns and refuses invalid positions", () => {
    expect(offsetAt("a\r\n😀 + b", { line: 1, column: 3 })).toBe(6);
    expect(() => offsetAt(source, { line: -1, column: 0 })).toThrow();
    expect(() => offsetAt(source, { line: 99, column: 0 })).toThrow();
  });

  it("refuses source drift and out-of-region splices", async () => {
    const [candidate] = await enumerate(source, "physics.ts");
    if (!candidate) throw new Error("No candidates");
    expect(() =>
      applyCandidate(
        source.replace(candidate.original, "different"),
        candidate,
      ),
    ).toThrow();
    expect(() =>
      applyCandidate(source, { ...candidate, site: "input" }),
    ).toThrow();
  });

  it("requires paired, nonnested regions and ignores state modules", async () => {
    expect(() => regions("// @hotfix-site physics\n")).toThrow();
    expect(() => regions("// @hotfix-site-end input\n")).toThrow();
    expect(() =>
      regions("// @hotfix-site physics\n// @hotfix-site input\n"),
    ).toThrow();
    expect(await enumerate("export const state = 1 + 2;", "world.ts")).toEqual(
      [],
    );
  });
});
