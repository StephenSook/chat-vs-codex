import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  type PooledMutant,
  ROOT,
  sourceDigest,
} from "../../mutator/src/gate.js";
import { parseTrialResult } from "../src/statistics.js";
import { runTrial } from "../src/supervisor.js";

it.each([false, true])(
  "verifies the whole supervised flow with a fake CLI (test tamper=%s)",
  async (tamper) => {
    const scratch = await mkdtemp(join(tmpdir(), "trial-contract-"));
    const pathBefore = process.env.PATH;
    try {
      const pool = JSON.parse(
        await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
      ) as { mutants: PooledMutant[] };
      const mutant = pool.mutants.find((m) => m.family === "gravity-sign");
      if (!mutant) throw new Error("No candidate");
      const executable = join(scratch, "codex");
      await writeFile(
        executable,
        `#!/usr/bin/env node
      import fs from 'node:fs';import path from 'node:path';import{spawnSync}from'node:child_process';
      const args=process.argv.slice(2);
      const game=args[args.indexOf('--cd')+1];
      if(!['TMPDIR','TMP','TEMP'].every(key=>process.env[key]===path.join(game,'.tmp'))||!fs.statSync(process.env.TMPDIR).isDirectory()) {console.error('Wrong trial temporary directory');process.exit(71);}
      fs.mkdirSync(path.join(process.env.TMPDIR,'ssr'),{recursive:true});fs.writeFileSync(path.join(process.env.TMPDIR,'ssr/cache.js'),'cache');
      if(args[0]==='sandbox') {const i=args.indexOf('--');const r=spawnSync(args[i+1],args.slice(i+2),{cwd:args[args.indexOf('--cd')+1],encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);}
      if(args[0]!=='exec')process.exit(64);
      process.stdin.resume();process.stdin.on('end',()=>{
        const file=path.join(game,${JSON.stringify(tamper ? "fixtures/goldens.json" : "src/index.ts")});
        ${tamper ? "fs.writeFileSync(file,'{}');" : `const before=fs.readFileSync(file,'utf8');if(!before.includes(${JSON.stringify(mutant.replacement)}))process.exit(70);fs.writeFileSync(file,before.replace(${JSON.stringify(mutant.replacement)},${JSON.stringify(mutant.original)}));`}
        for(const e of [{type:'thread.started',thread_id:'fake-contract'},
          {type:'item.completed',item:{type:'agent_message',id:'answer',text:JSON.stringify({rootCause:'Contract test',file:'src/index.ts',line:1,explanation:'Contract test',confidence:1})}},
          {type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:4,output_tokens:2,cache_write_input_tokens:0,reasoning_output_tokens:0}}])console.log(JSON.stringify(e));
      });
    `,
      );
      await chmod(executable, 0o700);
      process.env.PATH = `${scratch}:${pathBefore ?? ""}`;
      const runsDirectory = join(scratch, "runs");
      await mkdir(runsDirectory);
      const result = parseTrialResult(
        await runTrial({
          mutant,
          model: "gpt-6.1-terra",
          effort: "low",
          trialId: "contract",
          batchId: "contract",
          sourceDigest: await sourceDigest(),
          dryRun: true,
          runsDirectory,
        }),
      );
      expect(result.status).toBe(tamper ? "loss" : "green");
      expect(result.exactRevert).toBe(!tamper);
      expect(result.usage?.input_tokens).toBe(12);
      expect(result.filesChanged).toContain(
        tamper ? "fixtures/goldens.json" : "src/index.ts",
      );
      if (tamper) expect(result.failureReason).toContain("Rejected change");
      else {
        expect(result.linesChanged).toBe(2);
        expect(result.timeToGreenMs).toBeGreaterThan(0);
      }
    } finally {
      if (pathBefore === undefined) delete process.env.PATH;
      else process.env.PATH = pathBefore;
      await rm(scratch, { recursive: true, force: true });
    }
  },
  30000,
);
