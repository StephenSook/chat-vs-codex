import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runPreflight } from "../src/preflight.js";

// CI lacks the macOS host's Codex/Seatbelt setup. The mandatory outside-sandbox
// canary runs this same validator with the real profile before issuing a receipt.
it.each([false, true])(
  "runs clean validation with local temp files, refusing a failed preflight (failure=%s)",
  async (fail) => {
    const scratch = await mkdtemp(join(tmpdir(), "preflight-contract-"));
    const pathBefore = process.env.PATH;
    try {
      const executable = join(scratch, "codex");
      const callsPath = join(scratch, "calls.jsonl");
      await writeFile(
        executable,
        `#!/usr/bin/env node
      import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import{spawnSync}from'node:child_process';
      const args=process.argv.slice(2);const game=args[args.indexOf('--cd')+1];const i=args.indexOf('--');
      fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify({args,game,temp:process.env.TMPDIR})+'\\n');
      if(args[0]!=='sandbox')process.exit(99);
      if(!['TMPDIR','TMP','TEMP'].every(key=>process.env[key]===path.join(game,'.tmp'))||os.tmpdir()!==path.join(game,'.tmp')||!fs.statSync(os.tmpdir()).isDirectory())process.exit(71);
      if(!args.includes('--permission-profile')||!args.includes('hotfix')||!args.some(a=>a.includes('"/tmp" = "deny"')))process.exit(72);
      if(${fail}&&args[i+2].endsWith('vitest.mjs')){console.error("EPERM: operation not permitted, mkdir '/tmp/blocked/ssr'");process.exit(1);}
      fs.mkdirSync(path.join(os.tmpdir(),'ssr'),{recursive:true});fs.writeFileSync(path.join(os.tmpdir(),'ssr/cache.js'),'cache');
      const r=spawnSync(args[i+1],args.slice(i+2),{cwd:game,encoding:'utf8'});
      process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
    `,
      );
      await chmod(executable, 0o700);
      process.env.PATH = `${scratch}:${pathBefore ?? ""}`;
      const runs = join(scratch, "runs");
      if (fail) {
        await expect(runPreflight(runs)).rejects.toThrow(
          /Clean-source sandbox preflight failed before trial 1; no runtime trials started.*EPERM/s,
        );
      } else {
        expect(await runPreflight(runs)).toMatch(/preflight-.*\.jsonl$/);
      }
      const calls = (await readFile(callsPath, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { args: string[]; game: string; temp: string },
        );
      expect(calls).toHaveLength(fail ? 2 : 3);
      expect(calls.every((call) => call.args[0] === "sandbox")).toBe(true);
      expect(calls[1]?.args).toContainEqual(
        expect.stringMatching(/vitest.mjs$/),
      );
      if (!fail)
        expect(calls[2]?.args).toContainEqual(
          expect.stringMatching(/\.held-out-check.mjs$/),
        );
      for (const call of calls) {
        expect(call.temp).toBe(join(call.game, ".tmp"));
        await expect(stat(call.game)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const logs = await readdir(runs);
      expect(logs).toHaveLength(1);
      const log = await readFile(join(runs, logs[0] ?? ""), "utf8");
      expect(log).toContain(fail ? "preflight.failed" : "preflight.passed");
      if (fail) expect(log).not.toContain("preflight.passed");
      else {
        expect(log).toContain("21 passed");
        expect(log).toContain("Held-out replay passed");
      }
    } finally {
      if (pathBefore === undefined) delete process.env.PATH;
      else process.env.PATH = pathBefore;
      await rm(scratch, { recursive: true, force: true });
    }
  },
  30000,
);
