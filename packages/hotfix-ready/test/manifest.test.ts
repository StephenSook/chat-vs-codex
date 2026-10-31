import { describe, expect, it } from "vitest";
import { applyCandidate, enumerate } from "../../mutator/src/index.js";
import { authorizedRegions, discoverRegions } from "../src/manifest.js";

describe("sidecar authorization", () => {
  it.each(["ts", "js"])(
    "enumerates and splices %s without adding comments to source",
    async (extension) => {
      const source =
        "export function move(x" +
        (extension === "ts" ? ": number" : "") +
        ") { return x + 2; }\n";
      const sidecar = discoverRegions(source, `src/index.${extension}`);
      const regions = authorizedRegions(source, sidecar);
      const mutants = await enumerate(source, sidecar.file, regions);
      const candidate = mutants.find((m) => m.original === "x + 2");
      expect(candidate).toBeDefined();
      if (!candidate) throw new Error("Missing arithmetic mutant");
      expect(source).not.toContain("@hotfix-site");
      const patched = applyCandidate(source, candidate, regions);
      expect(patched).not.toEqual(source);
      expect(patched).not.toContain("@hotfix-site");
      expect(() => authorizedRegions(`${source} `, sidecar)).toThrow(
        "digest drift",
      );
      expect(() => applyCandidate(source, candidate)).toThrow("outside");
    },
  );
  it("refuses ambient/nondeterministic functions and invalid spans", () => {
    const file = discoverRegions(
      "function render(){document.body.textContent='x'} function bad(){return Math.random()} function good(x){return x+1}",
      "src/game.js",
    );
    expect(file.regions.map((r) => r.name)).toEqual(["good"]);
    expect(() =>
      authorizedRegions("abc", {
        file: "src/a.js",
        sha256: "bad",
        regions: [],
      }),
    ).toThrow();
  });
});
