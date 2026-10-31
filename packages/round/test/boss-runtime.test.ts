import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { loadProfile, runtimeEnvironment } from "../../bench/src/runtime.js";
import { git } from "../../bench/src/workspace.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { BOSS_MINIMUM_FREE_BYTES, newBossReceipt } from "../src/boss.js";
import { createRoundRuntime } from "../src/runtime.js";
import type { RepairExecution } from "../src/runtime-execution.js";

it("prepares exactly the same mutant in two neutral isolated workspaces with the same hotfix profile and per-workspace TMPDIR (fake repair worker)", async () => {
  const logs = await mkdtemp(join(tmpdir(), "boss-fixture-"));
  const oldPath = process.env.PATH;
  await writeFile(join(logs, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  process.env.PATH = `${logs}:${oldPath ?? ""}`;
  let prepared:
    | Awaited<ReturnType<ReturnType<typeof createRoundRuntime>["prepare"]>>
    | undefined;
  try {
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find((row) => row.family === "gravity-sign");
    if (!mutant) throw new Error("Missing fixture mutant");
    const calls: RepairExecution[] = [];
    const runtime = createRoundRuntime(
      {
        runsDirectory: logs,
        regressionsDirectory: join(logs, "regressions"),
        fixtureMutantId: mutant.id,
      },
      {
        repair: async (options, _signal, _event, _worker, observe) => {
          calls.push(options);
          observe?.({
            type: "runtime.phase",
            phase: "thread-started",
            atMs: 1,
            wallTime: "test",
          });
          return {
            id: options.model,
            code: "fake validated repair",
            digest: "a".repeat(64),
            timings: {
              threadStartedAtMs: 1,
              patchReadyAtMs: 2,
              validationStartedAtMs: 3,
              validationFinishedAtMs: 4,
            },
          };
        },
      },
    );
    const report = newBossReceipt({
      freeBytes: BOSS_MINIMUM_FREE_BYTES,
      rssBytes: 1,
      minimumFreeBytes: BOSS_MINIMUM_FREE_BYTES,
      measuredAtMs: 0,
    });
    prepared = await runtime.prepare(
      "fixture-boss",
      new AbortController().signal,
      undefined,
      report,
    );
    if (!prepared.repairBoss) throw new Error("Missing boss repair");
    await prepared.repairBoss({
      signal: new AbortController().signal,
      hint: null,
      event: () => {},
    });
    await prepared.settleBoss?.();
    expect(calls).toHaveLength(2);
    const [terra, sol] = calls;
    if (!terra || !sol) throw new Error("Missing threads");
    expect([terra.model, terra.effort, sol.model, sol.effort]).toEqual([
      "gpt-6.1-terra",
      "low",
      "gpt-6.1-sol",
      "high",
    ]);
    expect(terra.profile).toBe(await loadProfile());
    expect(sol.profile).toBe(terra.profile);
    expect(terra.ticket).toBe(sol.ticket);
    expect(terra.workspace.game).not.toBe(sol.workspace.game);
    expect(terra.workspace.home).not.toBe(sol.workspace.home);
    expect(terra.logFile).not.toBe(sol.logFile);
    expect(
      await readFile(join(terra.workspace.game, "src/index.ts"), "utf8"),
    ).toBe(await readFile(join(sol.workspace.game, "src/index.ts"), "utf8"));
    for (const call of calls) {
      expect(await readdir(dirname(call.workspace.game))).toEqual(["game"]);
      expect(git(call.workspace.game, ["rev-list", "--count", "HEAD"])).toBe(
        "1",
      );
      expect(call.logFile.startsWith(call.workspace.parent)).toBe(false);
      const env = runtimeEnvironment(call.workspace.game, call.workspace.home);
      expect(env.TMPDIR).toBe(join(call.workspace.game, ".tmp"));
      expect(env.TMP).toBe(env.TMPDIR);
      expect(env.TEMP).toBe(env.TMPDIR);
      expect(env.HOME).toBe(call.workspace.home);
    }
    expect(report.threads.map((thread) => thread.status)).toEqual([
      "validated",
      "validated",
    ]);
  } finally {
    await prepared?.close();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(logs, { recursive: true, force: true });
  }
}, 30000);
