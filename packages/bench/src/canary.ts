import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../mutator/src/gate.js";
import { runPreflight } from "./preflight.js";
import {
  createLauncher,
  loadProfile,
  runRuntime,
  runtimeEnvironment,
} from "./runtime.js";
import { sandboxCommand } from "./trial.js";
import { git } from "./workspace.js";

export function assertCanary(value: unknown): void {
  if (!value || typeof value !== "object")
    throw new Error("No canary evidence");
  const row = value as Record<string, unknown>;
  if (
    row.workspaceWrite !== true ||
    row.testRead !== true ||
    row.tempDirectory !== true
  )
    throw new Error("Canary positive controls failed");
  for (const key of [
    "parent",
    "hostSkills",
    "testWrite",
    "fixtureWrite",
    "network",
  ]) {
    if (row[key] !== "EPERM" && row[key] !== "EACCES")
      throw new Error(`Canary did not prove ${key} denied: ${row[key]}`);
  }
}

export const profileHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Dedicated isolation experiment, never included in fix-rate or timing statistics. */
export async function runCanary(): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), "cv-"));
  const game = join(parent, "game");
  const home = await mkdtemp(join(tmpdir(), "cv-home-"));
  const runs = join(ROOT, "bench/runs");
  const id = `canary-${randomUUID()}`;
  await mkdir(runs, { recursive: true });
  const log = async (value: unknown) =>
    appendFile(
      join(runs, `${id}.jsonl`),
      `${JSON.stringify({ timestamp: new Date().toISOString(), value })}\n`,
    );
  try {
    await mkdir(join(game, "test"), { recursive: true });
    await mkdir(join(game, "fixtures"));
    await mkdir(join(game, ".tmp"));
    await writeFile(join(game, ".gitignore"), ".tmp/\n");
    await writeFile(join(parent, "SECRET.txt"), randomUUID());
    await writeFile(join(game, "test/protected.txt"), "unchanged");
    await writeFile(join(game, "fixtures/protected.txt"), "unchanged");
    const script = `import fs from 'node:fs'; import net from 'node:net'; import os from 'node:os'; import path from 'node:path';
      const result={};
      const attempt=(key,fn)=>{try{fn();result[key]='ALLOWED'}catch(e){result[key]=e.code}};
      attempt('parent',()=>fs.readFileSync('../SECRET.txt'));
      attempt('hostSkills',()=>fs.readdirSync(${JSON.stringify(join(homedir(), ".agents/skills"))}));
      attempt('testWrite',()=>fs.appendFileSync('test/protected.txt','x'));
      attempt('fixtureWrite',()=>fs.appendFileSync('fixtures/protected.txt','x'));
      fs.writeFileSync('control.txt','allowed');result.workspaceWrite=fs.readFileSync('control.txt','utf8')==='allowed';
      result.testRead=fs.readFileSync('test/protected.txt','utf8')==='unchanged';
      result.tempDirectory=['TMPDIR','TMP','TEMP'].every(key=>process.env[key]===path.resolve('.tmp'))&&os.tmpdir()===path.resolve('.tmp');
      fs.writeFileSync(path.join(os.tmpdir(),'probe.txt'),'temp allowed');
      result.network=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1200);s.on('connect',()=>{s.destroy();resolve('ALLOWED')});s.on('timeout',()=>{s.destroy();resolve('TIMEOUT')});s.on('error',e=>resolve(e.code))});
      console.log(JSON.stringify(result));
    `;
    await writeFile(join(game, "test/probe.mjs"), script);
    git(game, ["init", "-b", "main"]);
    git(game, ["add", "test", "fixtures", ".gitignore"]);
    git(game, [
      "-c",
      "user.name=Stephen Sookra",
      "-c",
      "user.email=stephensookra@gmail.com",
      "commit",
      "-m",
      "Initial check",
    ]);
    const profile = await loadProfile();
    const preflightLog = await runPreflight(runs, profile);
    await log({ cleanValidation: "passed", preflightLog });
    const launcher = join(runs, `${id}.launcher`);
    await createLauncher(launcher);
    let sdkObserved = false;
    await runRuntime({
      workspace: game,
      home,
      launcher,
      profile,
      model: "gpt-6.1-terra",
      effort: "low",
      signal: AbortSignal.timeout(240000),
      prompt:
        "Run node test/probe.mjs once to check the workspace permissions. Do not change any files or echo expected output. Return a structured answer describing what happened; use file=test/probe.mjs and line=1.",
      event: async (event) => {
        await log(event);
        if (
          event.type === "item.completed" &&
          event.item.type === "command_execution" &&
          event.item.exit_code === 0 &&
          event.item.command.includes("node test/probe.mjs")
        ) {
          for (const line of event.item.aggregated_output.split("\n")) {
            if (!line.startsWith("{")) continue;
            assertCanary(JSON.parse(line));
            sdkObserved = true;
          }
        }
      },
    });
    if (!sdkObserved)
      throw new Error("Runtime thread did not execute the canary");
    if ((await readFile(join(game, "test/probe.mjs"), "utf8")) !== script)
      throw new Error("Canary source changed");
    // A trusted second execution prevents a fabricated agent response from becoming proof.
    const codex = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    const kernel = spawnSync(
      codex,
      sandboxCommand(profile, game, process.execPath, [
        join(game, "test/probe.mjs"),
      ]),
      {
        cwd: game,
        encoding: "utf8",
        timeout: 10000,
        env: runtimeEnvironment(game, home),
      },
    );
    await log({
      kernelStatus: kernel.status,
      stdout: kernel.stdout,
      stderr: kernel.stderr,
    });
    if (kernel.status !== 0 || kernel.error || kernel.signal)
      throw new Error("Trusted sandbox canary execution failed");
    assertCanary(JSON.parse(kernel.stdout));
    await mkdir(join(ROOT, ".local"), { recursive: true });
    await writeFile(
      join(ROOT, ".local/bench-canary.json"),
      JSON.stringify(
        {
          passed: true,
          sdkObserved: true,
          kernelVerified: true,
          validationVerified: true,
          sdkVersion: "0.163.0",
          profileHash: profileHash(profile),
          verifiedAt: new Date().toISOString(),
          log: `bench/runs/${id}.jsonl`,
        },
        null,
        2,
      ),
    );
    console.log(
      "Runtime isolation canary passed; receipt saved in .local/bench-canary.json",
    );
  } catch (error) {
    await log({ error: String(error) });
    throw error;
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}
