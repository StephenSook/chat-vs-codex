import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { armHardDeadline } from "../src/supervisor.js";
import { changedPaths, snapshot } from "../src/workspace.js";

it("kills a separate process group even when its JavaScript never yields", async () => {
  const child = spawn(process.execPath, ["-e", "while(true) {}"], {
    detached: true,
    stdio: "ignore",
  });
  let expired = false;
  const timer = armHardDeadline(child, 80, () => {
    expired = true;
  });
  try {
    const [, signal] = await once(child, "exit");
    expect(expired).toBe(true);
    expect(signal).toBe("SIGKILL");
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
  }
});

it("detects fixture tampering and refuses dependency or source links outside the workspace", async () => {
  const parent = await mkdtemp(join(tmpdir(), "snapshot-check-"));
  try {
    const game = join(parent, "game");
    await mkdir(join(game, "fixtures"), { recursive: true });
    await writeFile(join(game, "fixtures/goldens.json"), "original");
    const before = await snapshot(game);
    await writeFile(join(game, "fixtures/goldens.json"), "changed");
    expect(changedPaths(before, await snapshot(game))).toEqual([
      "fixtures/goldens.json",
    ]);
    await writeFile(join(parent, "outside.txt"), "private canary");
    await symlink(join(parent, "outside.txt"), join(game, "escape.ts"));
    await expect(snapshot(game)).rejects.toThrow(
      "Symlink escapes trial workspace",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
