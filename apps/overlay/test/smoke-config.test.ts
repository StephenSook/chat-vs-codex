import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("discovers the complete overlay browser suite without launching a browser", () => {
  const output = execFileSync("pnpm", ["smoke", "--list"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, CI: "true" },
  });
  expect(output).toContain("boss.spec.ts");
  expect(output).toContain("audio.spec.ts");
  expect(output).toContain("audio-obs.spec.ts");
  expect(output).toContain("symptom-autopilot.spec.ts");
  expect(output).toMatch(/Total: [1-9]\d* tests/);
});
