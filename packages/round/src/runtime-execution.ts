import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { build } from "esbuild";
import { confinedBundlePlugin } from "../../bench/src/confined-bundle.js";
import { type RuntimeOptions, runRuntime } from "../../bench/src/runtime.js";
import { validateWorkspace } from "../../bench/src/trial.js";
import {
  changedPaths,
  git,
  inspectChanges,
  snapshot,
  type TrialWorkspace,
} from "../../bench/src/workspace.js";
import { BUG_FAMILIES, type BugFamily } from "../../twitch/src/events.js";
import { eventStamp, monotonicMs } from "./clocks.js";
import type {
  GameArtifact,
  RoundValidationReplay,
  RuntimeObservation,
  RuntimePatch,
  RuntimePhaseObservation,
} from "./contracts.js";

export async function bundleGame(
  entry: string,
  workspace?: string,
): Promise<GameArtifact> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    sourcemap: false,
    minify: true,
    legalComments: "none",
    ...(workspace === undefined
      ? {}
      : { plugins: [confinedBundlePlugin(workspace)] }),
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error("Game build produced no browser artifact");
  const digest = createHash("sha256").update(code).digest("hex");
  return { id: digest, digest, code };
}

export interface RepairExecution {
  workspace: TrialWorkspace;
  launcher: string;
  profile: string;
  ticket: string;
  hint: BugFamily | null;
  model: string;
  effort: "low" | "high";
  logFile: string;
  budgetMs: number;
}

export interface RepairDependencies {
  runtime?: typeof runRuntime;
  validate?: typeof validateWorkspace;
  build?: typeof bundleGame;
}

/** Shared worker entry, with explicit offline test seams. Never writes clean source. */
export async function executeRepair(
  options: RepairExecution,
  signal: AbortSignal,
  event: (event: ThreadEvent) => void,
  dependencies: RepairDependencies = {},
  observe?: (observation: RuntimeObservation) => void,
): Promise<GameArtifact> {
  if (options.hint !== null && !BUG_FAMILIES.includes(options.hint))
    throw new Error("Invalid round hint");
  const started = monotonicMs();
  const timeout = AbortSignal.timeout(options.budgetMs);
  const combined = AbortSignal.any([signal, timeout]);
  const log = async (value: unknown, stamp = eventStamp()) => {
    await appendFile(
      options.logFile,
      `${JSON.stringify({ ...(value as object), ...stamp, timestamp: stamp.wallTime })}\n`,
    );
  };
  const phaseLogs: Promise<void>[] = [];
  let phaseLogFailure: unknown;
  const phase = (value: RuntimePhaseObservation["phase"]): number => {
    combined.throwIfAborted();
    const observation: RuntimeObservation = {
      type: "runtime.phase",
      phase: value,
      ...eventStamp(),
    };
    observe?.(observation);
    phaseLogs.push(
      log({ kind: observation.type, ...observation }, observation).catch(
        (error: unknown) => {
          phaseLogFailure ??= error;
        },
      ),
    );
    combined.throwIfAborted();
    return observation.atMs;
  };
  const remaining = () => options.budgetMs - (monotonicMs() - started);
  const check = async (allowUnchanged = false) => {
    combined.throwIfAborted();
    if (remaining() <= 0) throw new Error("Round repair deadline expired");
    const changes = await inspectChanges(
      options.workspace.game,
      options.workspace.before,
    );
    if (!allowUnchanged && !changes.filesChanged.length)
      throw new Error("No source repair");
    if (changes.filesChanged.some((path) => !/^src\/[^/]+\.ts$/.test(path)))
      throw new Error("Rejected change to tests, fixtures or tooling");
    if (
      git(options.workspace.game, ["rev-parse", "HEAD"]) !==
        options.workspace.initialHead ||
      git(options.workspace.game, ["rev-list", "--count", "HEAD"]) !== "1"
    )
      throw new Error("Rejected rewrite of game history");
    return changes;
  };
  let lastPatchFingerprint: string | undefined;
  const sourcePatch = async (): Promise<RuntimePatch> => {
    // Snapshot guards run before any source preview leaves the private worker.
    // SDK file-change summaries and aggregate shell exits are not diff evidence.
    await check(true);
    const game = options.workspace.game;
    const diffArgs = ["diff", "--no-ext-diff", "--no-textconv"];
    const diff = git(game, [...diffArgs, "--unified=0", "HEAD", "--", "src"]);
    const patch: RuntimePatch = { added: 0, removed: 0, preview: [] };
    for (const line of git(game, [
      ...diffArgs,
      "--numstat",
      "HEAD",
      "--",
      "src",
    ])
      .split("\n")
      .filter(Boolean)) {
      const [added, removed] = line.split("\t");
      if (!/^\d+$/.test(added ?? "") || !/^\d+$/.test(removed ?? ""))
        throw new Error("Nontext source change");
      patch.added += Number(added);
      patch.removed += Number(removed);
    }
    const preview = diff
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---) /.test(line));
    const untracked: [string, string][] = [];
    for (const path of git(game, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "src",
    ])
      .split("\n")
      .filter(Boolean)
      .sort()) {
      const source = await readFile(join(game, path), "utf8");
      const lines = source.length ? source.split("\n") : [];
      if (source.endsWith("\n")) lines.pop();
      patch.added += lines.length;
      preview.push(...lines.map((line) => `+${line}`));
      untracked.push([path, source]);
    }
    patch.preview = preview.slice(0, 4);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([diff, untracked]))
      .digest("hex");
    if (
      fingerprint !== lastPatchFingerprint &&
      (patch.added || patch.removed || lastPatchFingerprint !== undefined)
    ) {
      const observation: RuntimeObservation = {
        type: "runtime.patch",
        patch,
        ...eventStamp(),
      };
      await log({ kind: observation.type, ...observation }, observation);
      combined.throwIfAborted();
      observe?.(observation);
    }
    lastPatchFingerprint = fingerprint;
    return patch;
  };
  try {
    combined.throwIfAborted();
    const runtimeOptions: RuntimeOptions = {
      workspace: options.workspace.game,
      home: options.workspace.home,
      launcher: options.launcher,
      profile: options.profile,
      model: options.model,
      effort: options.effort,
      signal: combined,
      prompt:
        options.ticket +
        (options.hint === null ? "" : `\n\nHint: ${options.hint}`),
      event: async (value) => {
        await log({
          kind: "runtime.event",
          elapsedMs: monotonicMs() - started,
          event: value,
        });
        if (
          value.type === "item.completed" &&
          (value.item.type === "command_execution" ||
            value.item.type === "file_change")
        )
          await sourcePatch();
        if (!combined.aborted) event(value);
      },
    };
    const threadStartedAtMs = phase("thread-started");
    const completed = await (dependencies.runtime ?? runRuntime)(
      runtimeOptions,
    );
    await check();
    const patch = await sourcePatch();
    const submitted = await snapshot(options.workspace.game);
    // This marks the submitted patch after the SDK turn and source guards pass.
    // It does not claim to measure the first source edit during the turn.
    const patchReadyAtMs = phase("patch-ready");
    const validationStartedAtMs = phase("validation-started");
    const sourceDigest = createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(submitted).filter(([path]) => path.startsWith("src/")),
        ),
      )
      .digest("hex");
    let replay: RoundValidationReplay | undefined;
    await (dependencies.validate ?? validateWorkspace)(
      options.workspace,
      options.profile,
      remaining,
      log,
      async (validated) => {
        combined.throwIfAborted();
        await check();
        if (
          changedPaths(submitted, await snapshot(options.workspace.game)).length
        )
          throw new Error("Game files changed before replay publication");
        replay = { ...validated, sourceDigest };
        const observation: RuntimeObservation = {
          type: "runtime.replay",
          replay,
          ...eventStamp(),
        };
        await log({ kind: observation.type, ...observation }, observation);
        combined.throwIfAborted();
        observe?.(observation);
      },
    );
    const changes = await check();
    const verified = await snapshot(options.workspace.game);
    if (changedPaths(submitted, verified).length)
      throw new Error("Game files changed during verification");
    // Only verified source is bundled; failed checks cannot publish an artifact.
    const artifact = await (dependencies.build ?? bundleGame)(
      join(options.workspace.game, "src/index.ts"),
      options.workspace.game,
    );
    await check();
    if (changedPaths(verified, await snapshot(options.workspace.game)).length)
      throw new Error("Game files changed while bundling verified source");
    const validationFinishedAtMs = phase("validation-passed");
    await Promise.all(phaseLogs);
    if (phaseLogFailure) throw phaseLogFailure;
    await log({
      kind: "repair.verified",
      elapsedMs: monotonicMs() - started,
      ...changes,
      digest: artifact.digest,
      ...(replay
        ? {
            replaySourceDigest: replay.sourceDigest,
            replayTrackDigest: replay.trackDigest,
            replayFrames: replay.frames.length,
          }
        : {}),
    });
    return {
      ...artifact,
      patch,
      ...(replay ? { replay } : {}),
      ...(completed.answer === null ? {} : { diagnosis: completed.answer }),
      timings: {
        threadStartedAtMs,
        patchReadyAtMs,
        validationStartedAtMs,
        validationFinishedAtMs,
      },
    };
  } catch (error) {
    await Promise.all(phaseLogs);
    await log({ kind: "repair.failed", error: String(error) });
    throw error;
  }
}
