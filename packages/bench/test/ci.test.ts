import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

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
