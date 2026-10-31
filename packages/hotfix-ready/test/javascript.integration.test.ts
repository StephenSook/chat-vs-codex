import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ROOT } from "../../mutator/src/gate.js";
import { gatePool } from "../src/gate.js";
import { discoverRegions } from "../src/manifest.js";

const SOURCE = "export function speed() { return 2 + 2; }\n";
const REPLAY = `import {speed} from './src/index.js';import {TRACKS} from './tracks.js';
function run(length:number) {let x=0;const samples=[];const hashes=[];for(let frame=1;frame<=length;frame++){x+=speed()*256;const stateHash=(x>>>0).toString(16).padStart(8,'0');samples.push({frame,x,y:0,alive:Number.isSafeInteger(x),won:false,stateHash});if(frame%60===0)hashes.push({frame,hash:stateHash});}return{samples,hashes,outcome:{frame:length,x,y:0,alive:Number.isSafeInteger(x),won:false}};}
export function gateEvidence(){const survival=run(1200);return{tracks:TRACKS.map(track=>({name:track.name,...run(track.inputs.length)})),canary:{frames:survival.outcome.frame,alive:survival.outcome.alive,won:survival.outcome.won}};}`;
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hotfix-js-"));
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src/index.js"), SOURCE);
  await writeFile(
    join(directory, "hotfix-sites.json"),
    JSON.stringify({
      schemaVersion: 1,
      files: [discoverRegions(SOURCE, "src/index.js")],
    }),
  );
  await writeFile(
    join(directory, "tracks.ts"),
    `export const TRACKS=[{name:'replay-01',seed:13,inputs:Array<number>(600).fill(0)}];`,
  );
  await writeFile(join(directory, "replay.ts"), REPLAY);
  return directory;
}
it("gates an actual JavaScript game through tsc, minification, visible replay failure and canary without editing its source", async () => {
  const directory = await fixture();
  try {
    const pool = await gatePool(directory, ROOT);
    expect(pool.enumerated).toBeGreaterThan(0);
    expect(pool.mutants.length).toBeGreaterThan(0);
    expect(
      pool.mutants.every(
        (mutant) =>
          mutant.file === "src/index.js" && mutant.gates.canaryFrames === 1200,
      ),
    ).toBe(true);
    expect(await readFile(join(directory, "src/index.js"), "utf8")).toBe(
      SOURCE,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
it("refuses a clean type error and a clean infinite-loop adapter before enumerating a pool", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, "replay.ts"),
      `${REPLAY}\nconst broken: number='no';`,
    );
    await expect(gatePool(directory, ROOT)).rejects.toThrow();
    await writeFile(
      join(directory, "replay.ts"),
      REPLAY.replace(
        "const survival=run(1200);",
        "while(true) {} const survival=run(1200);",
      ),
    );
    await expect(gatePool(directory, ROOT)).rejects.toThrow(
      /SIGKILL|ETIMEDOUT/,
    );
    expect(await readFile(join(directory, "src/index.js"), "utf8")).toBe(
      SOURCE,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("refuses a clean adapter that wins early while still alive", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, "replay.ts"),
      REPLAY.replace(
        "const survival=run(1200);",
        "const survival=run(1);survival.outcome.won=true;",
      ),
    );
    await expect(gatePool(directory, ROOT)).rejects.toThrow("Clean canary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
