import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { GatePool } from "../../hotfix-ready/src/gate.js";
import { ROOT } from "../../mutator/src/gate.js";
import { runTrial } from "../src/supervisor.js";
import { git, prepareWorkspace } from "../src/workspace.js";

it("isolates the second game without exposing its name, source, sidecar or held-out route", async () => {
  const workspace = await prepareWorkspace(null, undefined, false, "breakout");
  try {
    expect(await readdir(workspace.parent)).toEqual(["game"]);
    expect(git(workspace.game, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await readdir(workspace.game)).not.toContain("hotfix-sites.json");
    expect(
      await readFile(join(workspace.game, ".gitignore"), "utf8"),
    ).toContain(".tmp/");
    const tracks = await readFile(
      join(workspace.game, "fixtures/tracks.json"),
      "utf8",
    );
    expect(tracks).not.toContain("held-out");
    expect(tracks).not.toContain('"seed":71');
  } finally {
    await workspace.cleanup();
  }
}, 30000);
it.each([false, true])(
  "uses the existing SDK runner, visible plus held-out gate and test protection (tamper=%s)",
  async (tamper) => {
    const scratch = await mkdtemp(join(tmpdir(), "adapter-contract-"));
    const oldPath = process.env.PATH;
    try {
      const pool = JSON.parse(
        await readFile(join(ROOT, "games/breakout/pool.json"), "utf8"),
      ) as GatePool;
      const mutant =
        pool.mutants.find((m) => m.family === "wallBounce") ?? pool.mutants[0];
      if (!mutant) throw new Error("No gated candidate");
      const clean = await readFile(
        join(ROOT, "games/breakout", mutant.file),
        "utf8",
      );
      const executable = join(scratch, "codex");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import{spawnSync}from'node:child_process';
const args=process.argv.slice(2);const game=args[args.indexOf('--cd')+1];
if(!['TMPDIR','TMP','TEMP'].every(key=>process.env[key]===path.join(game,'.tmp')))process.exit(71);
if(args[0]==='sandbox'){const i=args.indexOf('--');const r=spawnSync(args[i+1],args.slice(i+2),{cwd:game,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}
process.stdin.resume();process.stdin.on('end',()=>{
if(fs.readdirSync(path.join(game,'test')).some(name=>name.includes('held-out')))throw new Error('Held-out input exposed before runtime exit');
fs.writeFileSync(path.join(game,${JSON.stringify(tamper ? "fixtures/goldens.json" : mutant.file)}),${JSON.stringify(tamper ? "{}" : clean)});
for(const event of [{type:'thread.started',thread_id:'adapter-fixture'},{type:'item.completed',item:{type:'agent_message',id:'answer',text:JSON.stringify({rootCause:'Fixture',file:'src/index.ts',line:1,explanation:'Fixture test only',confidence:1})}},{type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:4,output_tokens:2}}])console.log(JSON.stringify(event));
});`,
      );
      await chmod(executable, 0o700);
      process.env.PATH = `${scratch}:${oldPath ?? ""}`;
      const runsDirectory = join(scratch, "runs");
      await mkdir(runsDirectory);
      const result = await runTrial({
        gameId: "breakout",
        mutant,
        model: "gpt-6.1-terra",
        effort: "low",
        trialId: "adapter-contract",
        batchId: "adapter-contract",
        sourceDigest: pool.sourceDigest,
        dryRun: true,
        runsDirectory,
      });
      expect(result.status).toBe(tamper ? "loss" : "green");
      expect(result.exactRevert).toBe(!tamper);
      if (tamper) expect(result.failureReason).toContain("Rejected change");
      else
        expect(
          await readFile(join(runsDirectory, "adapter-contract.jsonl"), "utf8"),
        ).toContain("Held-out replay passed");
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(scratch, { recursive: true, force: true });
    }
  },
  30000,
);
