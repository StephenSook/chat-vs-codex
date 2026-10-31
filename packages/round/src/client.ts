import { execFileSync, spawn } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { BroadcastState } from "../../../apps/overlay/src/events.js";
import { loadProfile, runtimeEnvironment } from "../../bench/src/runtime.js";
import { sandboxCommand } from "../../bench/src/trial.js";
import type { GameArtifact, RoundEnvelope } from "./contracts.js";

export interface ClientSnapshot {
  frame: number;
  hash: string;
  alive: boolean;
  won: boolean;
  buildId: string | null;
  installs: { buildId: string; frame: number; statePreserved: boolean }[];
  broadcast: BroadcastState;
  sdkSteps: number;
}

/** Patched game code executes only in a separate process under the hotfix profile. */
export async function startGameClient(logFile: string) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "cv-client-")));
  const game = join(parent, "game");
  const home = await mkdtemp(join(tmpdir(), "cv-home-"));
  await mkdir(join(game, ".tmp"), { recursive: true });
  try {
    await build({
      entryPoints: [
        fileURLToPath(new URL("./client-worker.ts", import.meta.url)),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: join(game, "client.mjs"),
    });
    await writeFile(join(game, ".gitignore"), ".tmp/\n");
    execFileSync("git", ["init", "-q", game]);
    const codex = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    const child = spawn(
      codex,
      sandboxCommand(await loadProfile(), game, process.execPath, [
        "--experimental-vm-modules",
        join(game, "client.mjs"),
      ]),
      {
        cwd: game,
        env: runtimeEnvironment(game, home),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map<
      number,
      {
        resolve(value: ClientSnapshot): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const output = createInterface({ input: child.stdout });
    let serial = 0;
    let exited = false;
    const reap = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = () => {
      exited = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(`Sandboxed game client stopped; see ${logFile}`));
      }
      pending.clear();
    };
    child.on("error", fail);
    child.on("exit", () => {
      reap();
      fail();
    });
    child.stdin.on("error", fail);
    child.stderr.on("data", (bytes: Buffer) => {
      void appendFile(logFile, bytes);
    });
    output.on("line", (line) => {
      try {
        const reply = JSON.parse(line) as {
          id: number;
          ok: boolean;
          snapshot: ClientSnapshot;
        };
        const item = pending.get(reply.id);
        if (!item) return;
        pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.ok) item.resolve(reply.snapshot);
        else item.reject(new Error("Sandboxed game client rejected the build"));
      } catch {
        fail();
        reap();
      }
    });
    const request = (
      kind: string,
      payload: object = {},
      signal?: AbortSignal,
    ) =>
      new Promise<ClientSnapshot>((resolve, reject) => {
        if (exited) {
          reject(
            new Error(`Sandboxed game client is unavailable; see ${logFile}`),
          );
          return;
        }
        if (signal?.aborted) {
          reject(new Error("Game client operation aborted"));
          return;
        }
        const id = ++serial;
        const abort = () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("Game client operation aborted"));
          reap();
        };
        const complete = (operation: () => void) => {
          signal?.removeEventListener("abort", abort);
          operation();
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          complete(() => reject(new Error("Sandboxed game client timed out")));
          reap();
        }, 5000);
        pending.set(id, {
          resolve: (value) => complete(() => resolve(value)),
          reject: (error) => complete(() => reject(error)),
          timer,
        });
        signal?.addEventListener("abort", abort, { once: true });
        child.stdin.write(`${JSON.stringify({ id, kind, ...payload })}\n`);
      });
    return {
      install: (artifact: GameArtifact, signal?: AbortSignal) =>
        request("install", { artifact }, signal),
      event: (envelope: RoundEnvelope) => request("event", { envelope }),
      snapshot: () => request("snapshot"),
      async close() {
        if (!exited) await request("close").catch(() => {});
        child.stdin.end();
        if (!exited) {
          const timer = setTimeout(reap, 2000);
          await new Promise<void>((done) => child.once("exit", () => done()));
          clearTimeout(timer);
        }
        reap();
        output.close();
        await rm(parent, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
