import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { committedSource } from "../../../scripts/judge-evidence.js";
import type { JudgeEvidence } from "../src/evidence.js";
import { sha256 } from "../src/proof.js";
import type { JudgeStatus } from "../src/status.js";

it("loads the actual Vite config in Node and builds exact committed comparison artifacts", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const before = Date.now();
  execFileSync("pnpm", ["judge:build"], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 12000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: "pipe",
  });
  const output = new URL("../dist/", import.meta.url);
  const evidence = JSON.parse(
    await readFile(new URL("evidence/index.json", output), "utf8"),
  ) as JudgeEvidence;
  expect(evidence.commit).toBe(committedSource(root).commit);
  const status = JSON.parse(
    await readFile(new URL("status.json", output), "utf8"),
  ) as JudgeStatus;
  expect(status.commit).toBe(evidence.commit);
  expect(status.rounds.total).toBe(evidence.rounds.length);
  expect(Date.parse(status.builtAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(status.builtAt)).toBeLessThanOrEqual(Date.now());
  const round = evidence.rounds.find((row) =>
    row.receipt.roundId.startsWith("c81bdc19"),
  );
  expect(round?.comparison?.status).toBe("available");
  if (round?.comparison?.status !== "available")
    throw new Error("Missing original build from the committed comparison");
  expect(
    await sha256(
      await readFile(new URL(round.comparison.brokenArtifactPath, output)),
    ),
  ).toBe(round.comparison.brokenBuildDigest);
});
