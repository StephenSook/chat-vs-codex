import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadProfile } from "./runtime.js";
import { validateWorkspace } from "./trial.js";
import { changedPaths, prepareWorkspace, snapshot } from "./workspace.js";

/** Real clean-source verification under the trial profile; never starts a model. */
export async function runPreflight(
  runsDirectory: string,
  profile?: string,
): Promise<string> {
  await mkdir(runsDirectory, { recursive: true });
  const path = join(runsDirectory, `preflight-${randomUUID()}.jsonl`);
  const log = async (value: unknown) => {
    await appendFile(
      path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...(value as object) })}\n`,
    );
  };
  const workspace = await prepareWorkspace(null);
  try {
    const permissions = profile ?? (await loadProfile());
    await log({
      kind: "preflight.started",
      workspace: workspace.game,
      tempDirectory: join(workspace.game, ".tmp"),
      profile: permissions,
    });
    const started = performance.now();
    await validateWorkspace(
      workspace,
      permissions,
      () => 60000 - (performance.now() - started),
      log,
    );
    if (changedPaths(workspace.before, await snapshot(workspace.game)).length)
      throw new Error("Clean-source validation changed protected files");
    await log({ kind: "preflight.passed" });
    return path;
  } catch (error) {
    await log({ kind: "preflight.failed", error: String(error) });
    throw new Error(
      `Clean-source sandbox preflight failed before trial 1; no runtime trials started. See ${path}: ${error}`,
      { cause: error },
    );
  } finally {
    await workspace.cleanup();
  }
}
