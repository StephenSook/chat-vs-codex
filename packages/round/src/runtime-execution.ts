import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
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
import type { GameArtifact } from "./contracts.js";

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
): Promise<GameArtifact> {
  if (options.hint !== null && !BUG_FAMILIES.includes(options.hint))
    throw new Error("Invalid round hint");
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.budgetMs);
  const combined = AbortSignal.any([signal, timeout]);
  const log = async (value: unknown) =>
    appendFile(
      options.logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...(value as object) })}\n`,
    );
  const remaining = () => options.budgetMs - (performance.now() - started);
  const check = async () => {
    combined.throwIfAborted();
    if (remaining() <= 0) throw new Error("Round repair deadline expired");
    const changes = await inspectChanges(
      options.workspace.game,
      options.workspace.before,
    );
    if (!changes.filesChanged.length) throw new Error("No source repair");
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
          elapsedMs: performance.now() - started,
          event: value,
        });
        event(value);
      },
    };
    await (dependencies.runtime ?? runRuntime)(runtimeOptions);
    await check();
    const submitted = await snapshot(options.workspace.game);
    await (dependencies.validate ?? validateWorkspace)(
      options.workspace,
      options.profile,
      remaining,
      log,
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
    await log({
      kind: "repair.verified",
      elapsedMs: performance.now() - started,
      ...changes,
      digest: artifact.digest,
    });
    return artifact;
  } catch (error) {
    await log({ kind: "repair.failed", error: String(error) });
    throw error;
  }
}
