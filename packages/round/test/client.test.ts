import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { startGameClient } from "../src/client.js";
import type { GameArtifact } from "../src/contracts.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function bundled(source: string): Promise<GameArtifact> {
  const result = await build({
    stdin: {
      contents: source,
      resolveDir: resolve("packages/sim/src"),
      sourcefile: "game.ts",
      loader: "ts",
    },
    write: false,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error("No fixture game bundle");
  const digest = createHash("sha256").update(code).digest("hex");
  return { code, digest, id: digest };
}

async function clientFixture() {
  const directory = await mkdtemp(join(tmpdir(), "round-client-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const record = join(directory, "launch.json");
  const executable = join(directory, "codex");
  // This test adapter delegates to the real bundled Node client. It intentionally
  // simulates the sandbox launcher; it makes no Codex/model call and proves no OS policy.
  await writeFile(
    executable,
    `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst { writeFileSync } = require('node:fs');\nconst args = process.argv.slice(2);\nconst separator = args.indexOf('--');\nif (separator < 0) process.exit(42);\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ args, pid: process.pid, home: process.env.HOME, tmp: process.env.TMP, temp: process.env.TEMP, tmpdir: process.env.TMPDIR }));\nconst child = spawn(args[separator + 1], args.slice(separator + 2), { stdio: 'inherit' });\nchild.on('error', () => process.exit(1));\nchild.on('exit', code => process.exit(code ?? 1));\n`,
  );
  await chmod(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${directory}:${oldPath ?? ""}`;
  cleanups.push(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  });
  const client = await startGameClient(join(directory, "client.log"));
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await client.close();
    }
  };
  cleanups.push(close);
  await client.snapshot();
  const launch = JSON.parse(await readFile(record, "utf8")) as {
    args: string[];
    pid: number;
    home: string;
    tmp: string;
    temp: string;
    tmpdir: string;
  };
  return { client, close, launch };
}

describe("real headless hot-swap client with a test-only sandbox launcher", () => {
  it("installs broken then repaired simulation modules without resetting state or inventing green", async () => {
    const source = await readFile("packages/sim/src/index.ts", "utf8");
    const brokenSource = source.replace(
      "if (state.grounded) return vy + GRAVITY;",
      "if (state.grounded) return vy - GRAVITY;",
    );
    expect(brokenSource).not.toBe(source);
    const clean = await bundled(source);
    const broken = await bundled(brokenSource);
    const f = await clientFixture();
    const first = await f.client.snapshot();
    const bad = await f.client.install(broken);
    expect(bad.buildId).toBe(broken.id);
    expect(bad.frame).toBeGreaterThanOrEqual(first.frame);
    expect(bad.installs).toHaveLength(1);
    expect(bad.installs[0]?.statePreserved).toBe(true);
    expect(bad.broadcast.bug).toBe("none");
    expect(bad.sdkSteps).toBe(0);
    const repaired = await f.client.install(clean);
    expect(repaired.buildId).toBe(clean.id);
    expect(repaired.frame).toBeGreaterThanOrEqual(bad.frame);
    expect(repaired.installs.every((item) => item.statePreserved)).toBe(true);
    expect(repaired.broadcast.bug).not.toBe("fixed");
    expect(f.launch.args[0]).toBe("sandbox");
    expect(f.launch.args).toContain("hotfix");
    expect(f.launch.args.join(" ")).toContain('"/private/tmp" = "deny"');
    expect(f.launch.tmp).toBe(f.launch.tmpdir);
    expect(f.launch.temp).toBe(f.launch.tmpdir);
    expect(f.launch.tmpdir.endsWith("/game/.tmp")).toBe(true);
    await f.close();
    await expect(stat(dirname(f.launch.tmpdir))).rejects.toThrow();
    await expect(stat(f.launch.home)).rejects.toThrow();
  });

  it("rejects digest mismatches and invalid modules while keeping the last valid build", async () => {
    const source = await readFile("packages/sim/src/index.ts", "utf8");
    const clean = await bundled(source);
    const f = await clientFixture();
    await f.client.install(clean);
    await expect(
      f.client.install({ ...clean, code: `${clean.code} ` }),
    ).rejects.toThrow("rejected");
    await expect(
      f.client.install(await bundled("export const invalid = true;")),
    ).rejects.toThrow("rejected");
    const current = await f.client.snapshot();
    expect(current.buildId).toBe(clean.id);
    expect(current.installs).toHaveLength(1);
    expect(current.broadcast.bug).not.toBe("fixed");
  });

  it("aborts and reaps a hung install under the parent-controlled deadline", async () => {
    const hanging = await bundled(
      'import * as base from "./index.ts"; export const createState = base.createState; export const hashState = base.hashState; export function step() { while (true) {} }',
    );
    const f = await clientFixture();
    const controller = new AbortController();
    const pending = f.client.install(hanging, controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(pending).rejects.toThrow("aborted");
    } finally {
      clearTimeout(timer);
    }
    await f.close();
    expect(() => process.kill(f.launch.pid, 0)).toThrow();
  });

  it("kills an infinite install probe after the fixed five second request budget", async () => {
    const hanging = await bundled(
      'import * as base from "./index.ts"; export const createState = base.createState; export const hashState = base.hashState; export function step() { while (true) {} }',
    );
    const f = await clientFixture();
    const started = performance.now();
    await expect(f.client.install(hanging)).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
    await f.close();
    expect(() => process.kill(f.launch.pid, 0)).toThrow();
  }, 10000);
});
