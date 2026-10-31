import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../mutator/src/gate.js";
import { authorizedRegions, type HotfixManifest } from "../src/manifest.js";

it("runs the installed skill through the public package command without rewriting game source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "installed-skill-"));
  const source = "export function move(x) { return x + 2; }\n";
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/game.js"), source);
    const run = spawnSync(
      "pnpm",
      ["hotfix:ready", "discover", directory, "src/game.js"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(directory, "hotfix-sites.json"), "utf8"),
    ) as HotfixManifest;
    const file = manifest.files[0];
    if (!file) throw new Error("Skill did not discover a logic region");
    expect(
      authorizedRegions(source, file).map((region) => region.name),
    ).toEqual(["move"]);
    expect(await readFile(join(directory, "src/game.js"), "utf8")).toBe(source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
