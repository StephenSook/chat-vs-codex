import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";
import type { PooledMutant } from "../../mutator/src/gate.js";
import { goldenResult, HELD_OUT } from "../../replay/src/index.js";
import { confinedBundlePlugin } from "./confined-bundle.js";
import {
  createLauncher,
  loadProfile,
  permissionOverrides,
  runRuntime,
  runtimeEnvironment,
} from "./runtime.js";
import type { ModelSpec, TrialResult } from "./statistics.js";
import {
  REPLAY_TRACE_PREFIX,
  type ValidatedReplay,
  validatedReplay,
} from "./validated-replay.js";
import {
  changedPaths,
  git,
  inspectChanges,
  neutralReplayName,
  prepareWorkspace,
  snapshot,
  type TrialWorkspace,
} from "./workspace.js";

export const HARD_BUDGET_MS = 240000;

export function buildTicket(mutant: PooledMutant): string {
  const failures = mutant.evidence.filter((e) => e.failed);
  const frames = failures.flatMap((e) =>
    e.firstDivergence === null ? [] : [e.firstDivergence],
  );
  const symptom = failures.find((e) => e.visibleFrame !== null)?.symptom;
  if (!frames.length || !symptom)
    throw new Error("Missing observable evidence");
  return `Bug ticket\nFailing replays: ${failures.map((e) => neutralReplayName(e.name)).join(", ")}\nFirst divergent frame: ${Math.min(...frames)}\nViewer symptom: ${symptom}\n\nRepair the game source. Tests, fixtures and tooling are immutable. Run node node_modules/vitest/vitest.mjs run to check the repair. Return the requested structured diagnosis.`;
}

export function sandboxCommand(
  profile: string,
  workspace: string,
  program: string,
  args: string[],
): string[] {
  return [
    "sandbox",
    ...permissionOverrides(profile).flatMap((c) => ["-c", c]),
    "--permission-profile",
    "hotfix",
    "--cd",
    workspace,
    "--",
    program,
    ...args,
  ];
}

export async function validateWorkspace(
  workspace: TrialWorkspace,
  profile: string,
  remaining: () => number,
  log: (value: unknown) => Promise<void>,
  onReplay?: (replay: ValidatedReplay) => void | Promise<void>,
): Promise<void> {
  const codex = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  async function command(program: string, args: string[]): Promise<string> {
    const budget = Math.min(15000, remaining());
    if (budget <= 0) throw new Error("Hard trial budget expired");
    const result = spawnSync(
      codex,
      sandboxCommand(profile, workspace.game, program, args),
      {
        cwd: workspace.game,
        timeout: budget,
        killSignal: "SIGKILL",
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: runtimeEnvironment(workspace.game, workspace.home),
      },
    );
    await log({
      kind: "validation",
      program,
      args,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message ?? null,
    });
    if (result.status !== 0 || result.error || result.signal)
      throw new Error(
        `Validation failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
      );
    return result.stdout;
  }
  // A clean compile and the entire visible suite precede the held-out replay.
  await command(process.execPath, [
    join(workspace.game, "node_modules/typescript/bin/tsc"),
    "--noEmit",
  ]);
  await command(process.execPath, [
    join(workspace.game, "node_modules/vitest/vitest.mjs"),
    "run",
  ]);
  const hidden = join(workspace.game, "test/.held-out-check.mjs");
  let replay: ValidatedReplay | undefined;
  try {
    // Written only AFTER the runtime process has exited. Codex never sees this input.
    await build({
      stdin: {
        contents: `
        import { createState, step, hashState } from ${JSON.stringify(join(workspace.game, "src/index.ts"))};
        const track = ${JSON.stringify(HELD_OUT)};
        let state = createState(track.seed); const hashes = []; ${onReplay ? "const frames = [];" : ""}
        for (const input of track.inputs) {
          state = step(state,input);
          if(state.frame%60===0) hashes.push({frame:state.frame,hash:hashState(state)});
          ${onReplay ? "frames.push({frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won,stateHash:hashState(state)});" : ""}
        }
        const outcome={frame:state.frame,x:state.x,y:state.y,alive:state.alive,won:state.won};
        if(JSON.stringify({hashes,outcome})!==${JSON.stringify(JSON.stringify(goldenResult(HELD_OUT)))}) throw new Error('Held-out replay failed');
        console.log('Held-out replay passed');
        ${onReplay ? `console.log(${JSON.stringify(REPLAY_TRACE_PREFIX)} + JSON.stringify(frames));` : ""}
      `,
        loader: "ts",
        resolveDir: workspace.game,
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      plugins: [confinedBundlePlugin(workspace.game)],
      outfile: hidden,
    });
    const stdout = await command(process.execPath, [hidden]);
    if (onReplay) replay = validatedReplay(stdout);
  } finally {
    await rm(hidden, { force: true });
  }
  if (replay && onReplay) await onReplay(replay);
}

export function isSandboxFailure(message: string): boolean {
  // The PATH-alias warning can precede an unrelated fatal configuration error.
  const fatal = message.replace(/WARNING: proceeding,[^\n]*\n/g, "");
  return /operation not permitted|permission denied|EPERM|sandbox_apply|read-only file system|os error (?:1|13|30)\b/i.test(
    fatal,
  );
}

export interface TrialOptions extends ModelSpec {
  mutant: PooledMutant;
  trialId: string;
  batchId: string;
  sourceDigest: string;
  dryRun: boolean;
  runsDirectory: string;
}

export async function executeTrial(
  options: TrialOptions,
): Promise<TrialResult> {
  await mkdir(options.runsDirectory, { recursive: true });
  const logFile = join(options.runsDirectory, `${options.trialId}.jsonl`);
  const log = async (value: unknown) =>
    appendFile(
      logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...(value as object) })}\n`,
    );
  const result: TrialResult = {
    schemaVersion: 1,
    trialId: options.trialId,
    batchId: options.batchId,
    mutantId: options.mutant.id,
    family: options.mutant.family,
    model: options.model,
    effort: options.effort,
    status: "loss",
    timeToGreenMs: null,
    elapsedMs: 0,
    exactRevert: false,
    filesChanged: [],
    linesChanged: 0,
    usage: null,
    answer: null,
    failureReason: null,
    dryRun: options.dryRun,
    sourceDigest: options.sourceDigest,
    startedAt: new Date().toISOString(),
  };
  let workspace: TrialWorkspace | undefined;
  let started = 0;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    workspace = await prepareWorkspace(options.mutant);
    const profile = await loadProfile();
    const launcher = join(options.runsDirectory, `${options.trialId}.launcher`);
    await createLauncher(launcher);
    const ticket = buildTicket(options.mutant);
    await log({
      kind: "trial.started",
      mutant: options.mutant.id,
      family: options.mutant.family,
      workspace: workspace.game,
      ticket,
      model: options.model,
      effort: options.effort,
      profile,
    });
    result.startedAt = new Date().toISOString();
    started = performance.now();
    process.send?.({
      type: "started",
      game: workspace.game,
      home: workspace.home,
      before: workspace.before,
      startedAt: result.startedAt,
    });
    timer = setTimeout(
      () => abort.abort(new Error("Hard trial budget expired")),
      HARD_BUDGET_MS,
    );
    const completed = await runRuntime({
      ...options,
      workspace: workspace.game,
      home: workspace.home,
      launcher,
      profile,
      prompt: ticket,
      signal: abort.signal,
      event: async (event) => {
        if (event.type === "turn.completed")
          result.usage = {
            input_tokens: event.usage.input_tokens,
            cached_input_tokens: event.usage.cached_input_tokens,
            output_tokens: event.usage.output_tokens,
          };
        await log({
          kind: "runtime.event",
          elapsedMs: performance.now() - started,
          event,
        });
      },
    });
    result.answer = completed.answer;
    const checkChanges = async () => {
      if (!workspace) throw new Error("Missing workspace");
      const changes = changedPaths(
        workspace.before,
        await snapshot(workspace.game),
      );
      result.filesChanged = changes;
      if (changes.some((p) => !/^src\/[^/]+\.ts$/.test(p)))
        throw new Error("Rejected change to tests, fixtures or tooling");
      if (
        git(workspace.game, ["rev-parse", "HEAD"]) !== workspace.initialHead ||
        git(workspace.game, ["rev-list", "--count", "HEAD"]) !== "1"
      ) {
        throw new Error("Rejected rewrite of trial history");
      }
      if (!changes.length) throw new Error("No source repair");
    };
    await checkChanges();
    result.linesChanged = git(workspace.game, [
      "diff",
      "--numstat",
      "HEAD",
      "--",
      "src",
    ])
      .split("\n")
      .filter(Boolean)
      .reduce((n, line) => {
        const [added, removed] = line.split("\t");
        if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(removed ?? ""))
          throw new Error("Nontext source change");
        return n + Number(added) + Number(removed);
      }, 0);
    await validateWorkspace(
      workspace,
      profile,
      () => HARD_BUDGET_MS - (performance.now() - started),
      log,
    );
    await checkChanges();
    const elapsed = performance.now() - started;
    if (abort.signal.aborted || elapsed > HARD_BUDGET_MS)
      throw new Error("Hard trial budget expired");
    const files = await readdirSources(workspace.game);
    result.exactRevert =
      files.length === Object.keys(workspace.cleanSources).length &&
      (
        await Promise.all(
          files.map(
            async (p) =>
              (await readFile(join(workspace?.game ?? "", p), "utf8")) ===
              workspace?.cleanSources[p],
          ),
        )
      ).every(Boolean);
    result.elapsedMs = performance.now() - started;
    if (result.elapsedMs > HARD_BUDGET_MS)
      throw new Error("Hard trial budget expired");
    result.timeToGreenMs = result.elapsedMs;
    result.status = "green";
  } catch (error) {
    result.elapsedMs = started ? performance.now() - started : 0;
    result.failureReason = String(error);
    result.timeToGreenMs = null;
    result.exactRevert = false;
    result.status =
      options.dryRun && isSandboxFailure(String(error))
        ? "sandbox-blocked"
        : "loss";
    await log({ kind: "trial.error", error: String(error) });
  } finally {
    if (timer) clearTimeout(timer);
    if (workspace) {
      try {
        Object.assign(
          result,
          await inspectChanges(workspace.game, workspace.before),
        );
      } catch (error) {
        await log({ kind: "inspection.error", error: String(error) });
        result.status = "loss";
        result.timeToGreenMs = null;
        result.exactRevert = false;
        result.failureReason ??= `Final change inspection failed: ${error}`;
      }
    }
    await log({ kind: "trial.result", result });
    await workspace?.cleanup();
  }
  return result;
}

async function readdirSources(game: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(join(game, "src"))).map((p) => `src/${p}`).sort();
}
