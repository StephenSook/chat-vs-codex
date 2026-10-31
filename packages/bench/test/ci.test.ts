import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ROOT } from "../../mutator/src/gate.js";

it("keeps ci:local identical to the workflow command order", () => {
  const root = new URL("../../../", import.meta.url);
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", root),
    "utf8",
  );
  const commands = Array.from(
    workflow.matchAll(/^\s+- run: (.+)$/gm),
    (m) => m[1],
  );
  const pkg = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  ) as { scripts: Record<string, string> };
  expect(commands.length).toBeGreaterThan(0);
  expect(pkg.scripts["ci:local"]).toBe(commands.join(" && "));
});

it("ignores disposable launchers for both games while retaining their JSONL evidence", () => {
  for (const directory of ["bench/runs", "games/breakout/bench/runs"]) {
    for (const [name, ignored] of [
      ["trial.launcher", true],
      ["trial.jsonl", false],
    ] as const) {
      const result = spawnSync(
        "git",
        ["check-ignore", "--no-index", `${directory}/${name}`],
        {
          cwd: ROOT,
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(ignored ? 0 : 1);
      if (ignored) expect(result.stdout.trim()).toBe(`${directory}/${name}`);
    }
  }
});
