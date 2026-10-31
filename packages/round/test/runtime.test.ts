import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadRegressions } from "../../bench/src/regressions.js";
import { loadProfile } from "../../bench/src/runtime.js";
import { buildTicket } from "../../bench/src/trial.js";
import { git, prepareWorkspace } from "../../bench/src/workspace.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { HELD_OUT, runTrack } from "../../replay/src/index.js";
import { monotonicMs } from "../src/clocks.js";
import type { RuntimeObservation } from "../src/contracts.js";
import { createRoundRuntime, superviseRepair } from "../src/runtime.js";
import {
  bundleGame,
  executeRepair,
  type RepairExecution,
} from "../src/runtime-execution.js";

async function setup() {
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { mutants: PooledMutant[] };
  const mutant = pool.mutants.find((item) => item.family === "gravity-sign");
  if (!mutant) throw new Error("Missing gravity fixture");
  const workspace = await prepareWorkspace(mutant);
  const logs = await mkdtemp(join(tmpdir(), "round-log-"));
  const options: RepairExecution = {
    workspace,
    profile: await loadProfile(),
    launcher: join(logs, "launcher"),
    ticket: buildTicket(mutant),
    hint: null,
    model: "gpt-6.1-terra",
    effort: "low",
    logFile: join(logs, "events.jsonl"),
    budgetMs: 10000,
  };
  const restore = async () => {
    for (const [path, source] of Object.entries(workspace.cleanSources)) {
      await readFile(join(workspace.game, path), "utf8");
      await writeFile(join(workspace.game, path), source);
    }
  };
  return {
    mutant,
    workspace,
    logs,
    options,
    restore,
    cleanup: async () => {
      await workspace.cleanup();
      await rm(logs, { recursive: true, force: true });
    },
  };
}

describe("round runtime verification", () => {
  it("rejects free text instead of passing it to private mutation selection", async () => {
    const runtime = createRoundRuntime({
      runsDirectory: join(tmpdir(), "unused-invalid-family"),
    });
    await expect(
      runtime.prepare(
        "invalid",
        new AbortController().signal,
        "free text" as Parameters<typeof runtime.prepare>[2],
      ),
    ).rejects.toThrow("Invalid private family selection");
  });
  it.each([false, true])(
    "publishes validator frames bound to unchanged patched source (tamper=%s)",
    async (tamper) => {
      const context = await setup();
      const observations: RuntimeObservation[] = [];
      try {
        const trace = {
          fps: 60 as const,
          trackDigest: createHash("sha256")
            .update(JSON.stringify(HELD_OUT))
            .digest("hex"),
          frames: runTrack(HELD_OUT).samples,
        };
        const repair = executeRepair(
          context.options,
          new AbortController().signal,
          () => {},
          {
            runtime: async () => {
              await context.restore();
              return { usage: null, answer: null };
            },
            validate: async (
              _workspace,
              _profile,
              _remaining,
              _log,
              onReplay,
            ) => {
              if (tamper)
                await writeFile(
                  join(context.workspace.game, "src/index.ts"),
                  `${await readFile(join(context.workspace.game, "src/index.ts"), "utf8")}\n// validation changed source\n`,
                );
              await onReplay?.(trace);
            },
          },
          (observation) => observations.push(observation),
        );
        if (tamper) {
          await expect(repair).rejects.toThrow("before replay publication");
          expect(
            observations.some((row) => row.type === "runtime.replay"),
          ).toBe(false);
        } else {
          const artifact = await repair;
          const observation = observations.find(
            (row) => row.type === "runtime.replay",
          );
          if (observation?.type !== "runtime.replay")
            throw new Error("Missing validator observation");
          expect(observation.replay.frames).toEqual(trace.frames);
          expect(observation.replay.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
          expect(artifact.replay).toEqual(observation.replay);
          const before = observations.findIndex(
            (row) =>
              row.type === "runtime.phase" &&
              row.phase === "validation-started",
          );
          const after = observations.findIndex(
            (row) =>
              row.type === "runtime.phase" && row.phase === "validation-passed",
          );
          expect(observations.indexOf(observation)).toBeGreaterThan(before);
          expect(observations.indexOf(observation)).toBeLessThan(after);
        }
      } finally {
        await context.cleanup();
      }
    },
    30000,
  );

  it("builds browser ESM artifacts with content-derived IDs", async () => {
    const result = await bundleGame(join(ROOT, "packages/sim/src/index.ts"));
    expect(result.id).toBe(result.digest);
    expect(result.digest).toBe(
      createHash("sha256").update(result.code).digest("hex"),
    );
    expect(result.code).toContain("export{");
    expect(result.code).not.toContain("node:");
    expect(result.code).not.toContain("sourceMappingURL");
  });

  it("validates a repaired isolated source before building and logs SDK events only outside the workspace", async () => {
    const context = await setup();
    try {
      const events: string[] = [];
      const order: string[] = [];
      const observations: RuntimeObservation[] = [];
      let runtimeEnteredAtMs = 0;
      let runtimeFinishedAtMs = 0;
      let validationEnteredAtMs = 0;
      let validationFinishedAtMs = 0;
      let bundleFinishedAtMs = 0;
      const diagnosis = {
        rootCause: "Gravity acceleration was reversed",
        file: "src/physics.ts",
        line: 12,
        explanation: "Restore downward acceleration",
        confidence: 0.97,
      };
      const runtime = vi.fn(async (options) => {
        runtimeEnteredAtMs = monotonicMs();
        order.push("runtime");
        expect(options.prompt).toContain("First divergent frame:");
        expect(options.prompt).not.toContain(context.mutant.id);
        expect(options.prompt).not.toContain(context.mutant.family);
        expect(options.workspace).toBe(context.workspace.game);
        expect(await readdir(context.workspace.parent)).toEqual(["game"]);
        expect(await readdir(context.workspace.home)).toEqual([]);
        expect(
          git(context.workspace.game, ["rev-list", "--count", "HEAD"]),
        ).toBe("1");
        expect(git(context.workspace.game, ["status", "--porcelain"])).toBe("");
        await context.restore();
        await options.event({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 10,
            output_tokens: 4,
          },
        });
        runtimeFinishedAtMs = monotonicMs();
        return { usage: null, answer: diagnosis };
      });
      const validate = vi.fn(async (workspace, profile, remaining) => {
        validationEnteredAtMs = monotonicMs();
        order.push("validate");
        expect(workspace.game).toBe(context.workspace.game);
        expect(profile).toBe(await loadProfile());
        expect(remaining()).toBeGreaterThan(0);
        await new Promise((done) => setTimeout(done, 10));
        validationFinishedAtMs = monotonicMs();
      });
      const build = vi.fn(async (entry) => {
        order.push("build");
        const artifact = await bundleGame(entry);
        bundleFinishedAtMs = monotonicMs();
        return artifact;
      });
      const result = await executeRepair(
        context.options,
        new AbortController().signal,
        (event) => events.push(event.type),
        { runtime, validate, build },
        (observation) => observations.push(observation),
      );
      expect(order).toEqual(["runtime", "validate", "build"]);
      expect(events).toEqual(["turn.completed"]);
      const {
        timings,
        patch,
        diagnosis: actualDiagnosis,
        ...artifact
      } = result;
      expect(actualDiagnosis).toEqual(diagnosis);
      expect(patch).toMatchObject({ added: 1, removed: 1 });
      expect(patch?.preview).toHaveLength(2);
      expect(artifact).toEqual(
        await bundleGame(join(ROOT, "packages/sim/src/index.ts")),
      );
      const phases = observations.filter(
        (observation) => observation.type === "runtime.phase",
      );
      expect(phases.map((observation) => observation.phase)).toEqual([
        "thread-started",
        "patch-ready",
        "validation-started",
        "validation-passed",
      ]);
      expect(timings).toEqual({
        threadStartedAtMs: phases[0]?.atMs,
        patchReadyAtMs: phases[1]?.atMs,
        validationStartedAtMs: phases[2]?.atMs,
        validationFinishedAtMs: phases[3]?.atMs,
      });
      if (!timings) throw new Error("Missing actual runtime boundary timings");
      expect(timings.threadStartedAtMs).toBeLessThanOrEqual(runtimeEnteredAtMs);
      expect(timings.patchReadyAtMs).toBeGreaterThanOrEqual(
        runtimeFinishedAtMs,
      );
      expect(timings.validationStartedAtMs).toBeGreaterThanOrEqual(
        timings.patchReadyAtMs,
      );
      expect(timings.validationStartedAtMs).toBeLessThanOrEqual(
        validationEnteredAtMs,
      );
      expect(timings.validationFinishedAtMs).toBeGreaterThanOrEqual(
        validationFinishedAtMs,
      );
      expect(timings.validationFinishedAtMs).toBeGreaterThanOrEqual(
        bundleFinishedAtMs,
      );
      expect(
        timings.validationFinishedAtMs - timings.validationStartedAtMs,
      ).toBeGreaterThanOrEqual(8);
      for (const observation of observations) {
        expect(Number.isFinite(Date.parse(observation.wallTime))).toBe(true);
      }
      const log = await readFile(context.options.logFile, "utf8");
      expect(log).toContain("runtime.event");
      expect(log).toContain("repair.verified");
      for (const line of log.trim().split("\n")) {
        const record = JSON.parse(line);
        expect(record.atMs).toBeGreaterThan(0);
        expect(record.wallTime).toBe(record.timestamp);
        expect(Number.isFinite(Date.parse(record.wallTime))).toBe(true);
      }
      expect(context.options.logFile.startsWith(context.workspace.parent)).toBe(
        false,
      );
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("observes real compound-command and untracked source diffs, deduplicating unchanged SDK summaries", async () => {
    const context = await setup();
    const observations: RuntimeObservation[] = [];
    try {
      const result = await executeRepair(
        context.options,
        new AbortController().signal,
        () => {},
        {
          runtime: async (options) => {
            await context.restore();
            const before = git(context.workspace.game, [
              "diff",
              "--numstat",
              "HEAD",
              "--",
              "src",
            ])
              .split("\t")
              .map(Number);
            execFileSync(
              "/bin/sh",
              [
                "-c",
                `"$NODE_BINARY" -e 'require("node:fs").appendFileSync("src/index.ts", "\\n// compound edit\\n")' && "$NODE_BINARY" -e 'require("node:fs").writeFileSync("src/extra.ts", "export const extra = 1;\\n")'`,
              ],
              {
                cwd: options.workspace,
                env: { ...process.env, NODE_BINARY: process.execPath },
                timeout: 5000,
              },
            );
            const completed = {
              type: "item.completed",
              item: {
                id: "compound",
                type: "command_execution",
                command: "node edit.js && node add.js",
                status: "completed",
                exit_code: 0,
                aggregated_output: "private output",
              },
            } as const;
            await options.event(completed);
            const first = observations.find(
              (observation) => observation.type === "runtime.patch",
            );
            expect(first).toMatchObject({
              patch: { added: (before[0] ?? 0) + 3, removed: before[1] },
            });
            expect(await readFile(context.options.logFile, "utf8")).toContain(
              "runtime.event",
            );
            await options.event({
              type: "item.completed",
              item: {
                type: "file_change",
                id: "inaccurate-sdk-count",
                status: "completed",
                changes: [{ path: "src/index.ts", kind: "update" }],
              },
            });
            await options.event(completed);
            return { usage: null, answer: null };
          },
          validate: async () => {},
        },
        (observation) => observations.push(observation),
      );
      const patches = observations.filter(
        (observation) => observation.type === "runtime.patch",
      );
      expect(patches).toHaveLength(1);
      expect(result.patch).toEqual(patches[0]?.patch);
      expect(result.patch?.preview).toHaveLength(4);
      expect(
        result.patch?.preview.every(
          (line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line),
        ),
      ).toBe(true);
      const log = (await readFile(context.options.logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        log.findIndex((record) => record.kind === "runtime.event"),
      ).toBeLessThan(
        log.findIndex((record) => record.kind === "runtime.patch"),
      );
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("rejects fixture edits before emitting a source preview or forwarding the completed command", async () => {
    const context = await setup();
    const observations: RuntimeObservation[] = [];
    const forwarded = vi.fn();
    const validate = vi.fn(async () => {});
    try {
      await expect(
        executeRepair(
          context.options,
          new AbortController().signal,
          forwarded,
          {
            runtime: async (options) => {
              await context.restore();
              await writeFile(
                join(options.workspace, "fixtures/goldens.json"),
                "private fixture alteration",
              );
              await options.event({
                type: "item.completed",
                item: {
                  type: "command_execution",
                  id: "bad",
                  command: "edit fixtures",
                  status: "completed",
                  exit_code: 0,
                  aggregated_output: "private fixture content",
                },
              });
              return { usage: null, answer: null };
            },
            validate,
          },
          (observation) => observations.push(observation),
        ),
      ).rejects.toThrow("Rejected change to tests, fixtures or tooling");
      expect(
        observations.some(
          (observation) => observation.type === "runtime.patch",
        ),
      ).toBe(false);
      expect(forwarded).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it.each([
    "tests",
    "history",
    "unchanged",
    "validation",
    "post-validation",
    "source-during-validation",
  ])(
    "refuses %s violations without creating a repaired artifact",
    async (kind) => {
      const context = await setup();
      const observations: RuntimeObservation[] = [];
      const build = vi.fn(async () => ({
        id: "invalid",
        digest: "invalid",
        code: "invalid",
      }));
      try {
        const runtime = vi.fn(async () => {
          if (kind !== "unchanged") await context.restore();
          if (kind === "tests") {
            const path = join(context.workspace.game, "fixtures/goldens.json");
            await readFile(path, "utf8");
            await writeFile(path, "{}");
          }
          if (kind === "history")
            git(context.workspace.game, [
              "-c",
              "user.name=Stephen Sookra",
              "-c",
              "user.email=test@example.invalid",
              "commit",
              "--allow-empty",
              "-m",
              "Changed history",
            ]);
          return { usage: null, answer: null };
        });
        const validate = vi.fn(async () => {
          if (kind === "validation") throw new Error("Held-out replay failed");
          if (kind === "post-validation") {
            const path = join(context.workspace.game, "test/replay.test.ts");
            await readFile(path, "utf8");
            await writeFile(path, "tampered");
          }
          if (kind === "source-during-validation") {
            const path = join(context.workspace.game, "src/index.ts");
            const source = await readFile(path, "utf8");
            await writeFile(path, `${source}\n// changed after replay\n`);
          }
        });
        await expect(
          executeRepair(
            context.options,
            new AbortController().signal,
            () => {},
            { runtime, validate, build },
            (observation) => observations.push(observation),
          ),
        ).rejects.toThrow();
        expect(build).not.toHaveBeenCalled();
        expect(
          observations
            .filter((observation) => observation.type === "runtime.phase")
            .map((observation) => observation.phase),
        ).not.toContain("validation-passed");
      } finally {
        await context.cleanup();
      }
    },
    30000,
  );

  it("accepts only one enum hint and does not start when already aborted", async () => {
    const context = await setup();
    try {
      const prompts: string[] = [];
      const runtime = vi.fn(async (options) => {
        prompts.push(options.prompt);
        await context.restore();
        return { usage: null, answer: null };
      });
      const validate = vi.fn(async () => {});
      await executeRepair(
        { ...context.options, hint: "jump-buffer" },
        new AbortController().signal,
        () => {},
        { runtime, validate },
      );
      expect(prompts[0]).toBe(`${context.options.ticket}\n\nHint: jump-buffer`);
      await expect(
        executeRepair(
          { ...context.options, hint: "anything else" as never },
          new AbortController().signal,
          () => {},
          { runtime, validate },
        ),
      ).rejects.toThrow("Invalid round hint");
      await expect(
        executeRepair(context.options, AbortSignal.abort(), () => {}, {
          runtime,
          validate,
        }),
      ).rejects.toThrow();
      const controller = new AbortController();
      await expect(
        executeRepair(
          context.options,
          controller.signal,
          () => {},
          { runtime, validate },
          () => controller.abort(),
        ),
      ).rejects.toThrow();
      expect(runtime).toHaveBeenCalledTimes(1);
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("kills a hanging detached worker on a hard deadline without invoking Codex", async () => {
    const context = await setup();
    try {
      const fake = join(context.logs, "hanging.mjs");
      await writeFile(
        fake,
        "process.on('message',()=>{setInterval(()=>{},1000)});",
      );
      await expect(
        superviseRepair(
          { ...context.options, budgetMs: 100 },
          new AbortController().signal,
          () => {},
          pathToFileURL(fake),
        ),
      ).rejects.toThrow("deadline expired");
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it.each([0, 1])(
    "requires a completed worker exit after its result (exit=%s)",
    async (exit) => {
      const context = await setup();
      try {
        const fake = join(context.logs, "result-worker.mjs");
        const artifact = { id: "fixture", digest: "fixture", code: "fixture" };
        await writeFile(
          fake,
          `process.once('message',()=>process.send({type:'result',artifact:${JSON.stringify(artifact)}},()=>process.exit(${exit})));`,
        );
        const task = superviseRepair(
          context.options,
          new AbortController().signal,
          () => {},
          pathToFileURL(fake),
        );
        if (exit === 0) await expect(task).resolves.toEqual(artifact);
        else await expect(task).rejects.toThrow("without a verified build");
      } finally {
        await context.cleanup();
      }
    },
    30000,
  );

  it("terminates an active worker when the caller cancels the round", async () => {
    const context = await setup();
    try {
      const fake = join(context.logs, "cancellable.mjs");
      await writeFile(
        fake,
        "process.once('message',()=>{process.send({type:'event',event:{type:'thread.started',thread_id:'fixture'}});setInterval(()=>{},1000)});",
      );
      const controller = new AbortController();
      const event = vi.fn(() => controller.abort());
      await expect(
        superviseRepair(
          context.options,
          controller.signal,
          event,
          pathToFileURL(fake),
        ),
      ).rejects.toThrow("aborted");
      expect(event).toHaveBeenCalledTimes(1);
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("forwards worker lifecycle stamps unchanged across IPC", async () => {
    const context = await setup();
    try {
      const fake = join(context.logs, "observed.mjs");
      const artifact = { id: "fixture", digest: "fixture", code: "fixture" };
      await writeFile(
        fake,
        `process.once('message',()=>{const observation={type:'runtime.phase',phase:'thread-started',atMs:Number(process.hrtime.bigint())/1000000,wallTime:new Date().toISOString()};console.log('worker fixture');process.send({type:'observation',observation},()=>process.send({type:'result',artifact:${JSON.stringify(artifact)}},()=>process.exit(0)));});`,
      );
      const before = monotonicMs();
      const observations: RuntimeObservation[] = [];
      await expect(
        superviseRepair(
          context.options,
          new AbortController().signal,
          () => {},
          pathToFileURL(fake),
          (observation) => observations.push(observation),
        ),
      ).resolves.toEqual(artifact);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        type: "runtime.phase",
        phase: "thread-started",
      });
      expect(observations[0]?.atMs).toBeGreaterThanOrEqual(before);
      expect(observations[0]?.atMs).toBeLessThanOrEqual(monotonicMs());
      const log = JSON.parse(
        (await readFile(context.options.logFile, "utf8")).trim(),
      );
      expect(log.kind).toBe("worker.stdout");
      expect(log.atMs).toBeGreaterThanOrEqual(before);
      expect(log.wallTime).toBe(log.timestamp);
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("suppresses queued lifecycle and SDK events after an observation cancels the worker", async () => {
    const context = await setup();
    try {
      const fake = join(context.logs, "stale-observation.mjs");
      await writeFile(
        fake,
        "process.once('message',()=>{const observation={type:'runtime.phase',phase:'thread-started',atMs:Number(process.hrtime.bigint())/1000000,wallTime:new Date().toISOString()};process.send({type:'observation',observation});process.send({type:'observation',observation:{...observation,phase:'patch-ready'}});process.send({type:'event',event:{type:'thread.started',thread_id:'stale'}});setInterval(()=>{},1000);});",
      );
      const controller = new AbortController();
      const observe = vi.fn(() => controller.abort());
      const event = vi.fn();
      await expect(
        superviseRepair(
          context.options,
          controller.signal,
          event,
          pathToFileURL(fake),
          observe,
        ),
      ).rejects.toThrow("aborted");
      expect(observe).toHaveBeenCalledTimes(1);
      expect(event).not.toHaveBeenCalled();
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it.each([0, 1])(
    "reaps lingering worker descendants after a normal worker exit (exit=%s)",
    async (exit) => {
      const context = await setup();
      let descendant: number | undefined;
      try {
        const fake = join(context.logs, "descendant.mjs");
        const artifact = { id: "fixture", digest: "fixture", code: "fixture" };
        await writeFile(
          fake,
          `import{spawn}from'node:child_process';process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.send({type:'event',event:{type:'thread.started',thread_id:String(child.pid)}},()=>process.send({type:'result',artifact:${JSON.stringify(artifact)}},()=>process.exit(${exit})));});`,
        );
        const task = superviseRepair(
          context.options,
          new AbortController().signal,
          (event) => {
            if (event.type === "thread.started")
              descendant = Number(event.thread_id);
          },
          pathToFileURL(fake),
        );
        if (exit === 0) await expect(task).resolves.toEqual(artifact);
        else await expect(task).rejects.toThrow();
        expect(descendant).toBeGreaterThan(0);
        await vi.waitFor(
          () => expect(() => process.kill(descendant ?? 0, 0)).toThrow(),
          { timeout: 2000, interval: 10 },
        );
      } finally {
        if (descendant) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
        }
        await context.cleanup();
      }
    },
    30000,
  );

  it("refuses a source changed while building the verified artifact", async () => {
    const context = await setup();
    try {
      await expect(
        executeRepair(context.options, new AbortController().signal, () => {}, {
          runtime: async () => {
            await context.restore();
            return { usage: null, answer: null };
          },
          validate: async () => {},
          build: async (entry) => {
            const artifact = await bundleGame(entry);
            const source = await readFile(entry, "utf8");
            await writeFile(entry, `${source}\n// changed during bundle\n`);
            return artifact;
          },
        }),
      ).rejects.toThrow("while bundling");
    } finally {
      await context.cleanup();
    }
  }, 30000);

  it("prepares clean/broken artifacts, hides mutant metadata, and cleans its isolated game", async () => {
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find(
      (item) => item.family === "swapped-controls",
    );
    if (!mutant) throw new Error("Missing controls fixture");
    const logs = await mkdtemp(join(tmpdir(), "round-factory-"));
    const priorPath = process.env.PATH;
    // Preparation must not depend on a host Codex installation or invoke a model.
    await writeFile(join(logs, "codex"), "#!/bin/sh\nexit 99\n", {
      mode: 0o700,
    });
    process.env.PATH = `${logs}:${priorPath ?? ""}`;
    try {
      const runtime = createRoundRuntime({
        runsDirectory: logs,
        fixtureMutantId: mutant.id,
      });
      const prepared = await runtime.prepare(
        "round-fixture",
        new AbortController().signal,
        "swapped-controls",
      );
      await expect(
        runtime.prepare(
          "wrong-family",
          new AbortController().signal,
          "gravity-sign",
        ),
      ).rejects.toThrow("No eligible pooled mutant");
      expect(prepared.family).toBe("swapped-controls");
      expect(prepared.clean.id).not.toBe(prepared.broken.id);
      expect(prepared.broken.code).not.toContain(mutant.id);
      expect(prepared.broken.code).not.toContain("hotfix-site");
      expect(
        (await readdir(logs)).some((name) => name.endsWith(".launcher")),
      ).toBe(true);
      await prepared.close();
      await prepared.close();
      await expect(
        prepared.repair({
          hint: null,
          signal: new AbortController().signal,
          event: () => {},
        }),
      ).rejects.toThrow("unavailable");
      expect((await stat(logs)).isDirectory()).toBe(true);
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      await rm(logs, { recursive: true, force: true });
    }
  }, 30000);

  it("records a factory regression only after verified repair, survives close, and excludes learned fixture selection (repair is a test double)", async () => {
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find(
      (item) => item.family === "swapped-controls",
    );
    if (!mutant) throw new Error("Missing controls fixture");
    const logs = await mkdtemp(join(tmpdir(), "round-credit-factory-"));
    const directory = join(logs, "records");
    const oldPath = process.env.PATH;
    await writeFile(join(logs, "codex"), "#!/bin/sh\nexit 99\n", {
      mode: 0o700,
    });
    process.env.PATH = `${logs}:${oldPath ?? ""}`;
    let prepared:
      | Awaited<ReturnType<ReturnType<typeof createRoundRuntime>["prepare"]>>
      | undefined;
    try {
      let finish!: (value: Awaited<ReturnType<typeof bundleGame>>) => void;
      const pending = new Promise<Awaited<ReturnType<typeof bundleGame>>>(
        (resolve) => {
          finish = resolve;
        },
      );
      const repair = vi.fn(async () => pending);
      const runtime = createRoundRuntime(
        {
          runsDirectory: logs,
          regressionsDirectory: directory,
          fixtureMutantId: mutant.id,
        },
        { repair },
      );
      const roundId = "00000000-0000-0000-0000-000000000003";
      prepared = await runtime.prepare(roundId, new AbortController().signal);
      const recordRegression = prepared.recordRegression;
      if (!recordRegression) throw new Error("Missing regression hook");
      const credit = { roundId, viewer: "viewer-dddddddddddddddd" };
      await expect(recordRegression(credit)).rejects.toThrow("verified repair");
      const repaired = prepared.repair({
        hint: null,
        signal: new AbortController().signal,
        event: () => {},
      });
      await expect(recordRegression(credit)).rejects.toThrow("verified repair");
      finish(prepared.clean);
      await repaired;
      await prepared.close();
      await expect(
        recordRegression({ ...credit, roundId: "wrong" }),
      ).rejects.toThrow("round mismatch");
      await writeFile(directory, "persistence unavailable");
      await expect(recordRegression(credit)).rejects.toThrow();
      await rm(directory);
      const receipt = await recordRegression(credit);
      expect(receipt.path).toBe(`chat-found/${roundId}.json`);
      expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(await recordRegression(credit)).toEqual(receipt);
      const records = await loadRegressions(directory);
      expect(records).toHaveLength(1);
      expect(records[0]?.mutantId).toBe(mutant.id);
      expect(records[0]?.viewer).toBe(credit.viewer);
      await expect(
        runtime.prepare("another-round", new AbortController().signal),
      ).rejects.toThrow("No eligible pooled mutant");
      expect(repair).toHaveBeenCalledOnce();
    } finally {
      await prepared?.close();
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(logs, { recursive: true, force: true });
    }
  }, 30000);
});
