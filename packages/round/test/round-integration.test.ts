import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadProfile } from "../../bench/src/runtime.js";
import { validateWorkspace } from "../../bench/src/trial.js";
import {
  prepareWorkspace,
  type TrialWorkspace,
} from "../../bench/src/workspace.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { type BugFamily, TwitchHandler } from "../../twitch/src/events.js";
import { parseFixture, replayFixtures } from "../../twitch/src/fixtures.js";
import { type ClientSnapshot, startGameClient } from "../src/client.js";
import type {
  GameArtifact,
  PreparedGame,
  RoundEnvelope,
} from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { bundleGame } from "../src/runtime-execution.js";
import { startRoundServer } from "../src/server.js";

it("routes Twitch fixtures through a full round, real validation, HTTP artifacts and a state-preserving client (SDK and policy adapters are test doubles)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "round-integration-"));
  const oldPath = process.env.PATH;
  let workspace: TrialWorkspace | undefined;
  let client: Awaited<ReturnType<typeof startGameClient>> | undefined;
  let server: Awaited<ReturnType<typeof startRoundServer>> | undefined;
  let engine: RoundEngine | undefined;
  let delivery: Promise<void> = Promise.resolve();
  try {
    const adapterLog = join(directory, "policy-test-double.jsonl");
    const executable = join(directory, "codex");
    // No Codex/model is invoked. This launcher test double runs the actual Node
    // validator/client commands without claiming that CI exercised OS policy.
    await writeFile(
      executable,
      `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2), separator = args.indexOf('--');
const workspace = args[args.indexOf('--cd') + 1];
if (args[0] !== 'sandbox' || separator < 0 || !['TMPDIR','TMP','TEMP'].every(key => process.env[key] === path.join(workspace,'.tmp'))) process.exit(72);
appendFileSync(${JSON.stringify(adapterLog)}, JSON.stringify({ args, workspace, tmpdir: process.env.TMPDIR }) + '\\n');
const child = spawn(args[separator+1], args.slice(separator+2), { stdio:'inherit', cwd:workspace });
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code ?? 1));
`,
    );
    await chmod(executable, 0o700);
    process.env.PATH = `${directory}:${oldPath ?? ""}`;

    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find(
      (candidate) => candidate.family === "gravity-sign",
    );
    if (!mutant) throw new Error("Missing pooled gravity fixture");
    workspace = await prepareWorkspace(mutant);
    const game = workspace;
    const clean = await bundleGame(join(ROOT, "packages/sim/src/index.ts"));
    const broken = await bundleGame(join(game.game, "src/index.ts"), game.game);
    expect(broken.id).not.toBe(clean.id);
    client = await startGameClient(join(directory, "client.log"));
    const runningClient = client;
    const envelopes: RoundEnvelope[] = [];
    const stages: string[] = [];
    const installs: {
      phase: string;
      before: ClientSnapshot;
      after: ClientSnapshot;
    }[] = [];
    const validation: { status: number; args: string[]; stdout: string }[] = [];
    let hint: BugFamily | null | undefined;
    let handler: TwitchHandler;
    let guessSent = false;
    const raw = JSON.parse(
      await readFile(
        join(ROOT, "packages/twitch/fixtures/session.json"),
        "utf8",
      ),
    ) as unknown[];
    const start = parseFixture(raw[0]);
    if (start.type !== "channel.chat.message")
      throw new Error("Missing chat fixture");
    const guess = {
      type: start.type,
      event: {
        ...start.event,
        message_id: "integration-wrong-guess",
        message: {
          text: "!guess swapped-controls",
          fragments: [
            { type: "text" as const, text: "!guess swapped-controls" },
          ],
        },
      },
    };
    const prepared: PreparedGame = {
      family: "gravity-sign",
      clean,
      broken,
      // The repair is explicitly a test double. The gate is the real full suite
      // and held-out replay, executed through the test-only policy launcher.
      async repair(options) {
        stages.push("sdk-repair-test-double");
        hint = options.hint;
        options.signal.throwIfAborted();
        for (const [path, source] of Object.entries(game.cleanSources))
          await writeFile(join(game.game, path), source);
        await validateWorkspace(
          game,
          await loadProfile(),
          () => 15_000,
          async (value) => {
            const row = value as {
              kind: string;
              status: number;
              args: string[];
              stdout: string;
            };
            if (row.kind === "validation") validation.push(row);
          },
        );
        stages.push("full-suite-and-held-out-passed");
        return bundleGame(join(game.game, "src/index.ts"), game.game);
      },
      close: async () => {},
    };
    server = await startRoundServer({
      install: async (artifact, signal) => {
        const before = await runningClient.snapshot();
        const after = await runningClient.install(artifact, signal);
        const phase = artifact.id === broken.id ? "broken" : "repaired";
        installs.push({ phase, before, after });
        stages.push(`installed-${phase}`);
      },
      record: (envelope) => {
        envelopes.push(envelope);
        if (
          envelope.event.type === "overlay" &&
          envelope.event.event.type === "tests.green"
        )
          stages.push("published-tests-green");
        delivery = delivery.then(async () => {
          await runningClient.event(envelope);
        });
        if (
          envelope.event.type === "round.state" &&
          envelope.event.phase === "head-start" &&
          !guessSent
        ) {
          guessSent = true;
          replayFixtures([guess], handler);
        }
      },
    });
    engine = new RoundEngine({
      runtime: { prepare: async () => prepared },
      publish: server.publish,
      activate: server.activate,
      headStartMs: 20,
    });
    const runningEngine = engine;
    handler = new TwitchHandler({
      broadcasterId: start.event.broadcaster_user_id,
      sink: {
        public: (intent) => runningEngine.handlePublic(intent),
        private: (intent) => {
          runningEngine.handlePrivate(intent);
        },
      },
    });
    replayFixtures([start], handler);
    const result = await engine.waitForRound();
    await delivery;
    expect(result).toMatchObject({
      phase: "resolved",
      winner: "codex",
      scores: { chat: 0, codex: 1 },
    });
    expect(guessSent).toBe(true);
    expect(hint).toBe("swapped-controls");
    expect(validation).toHaveLength(3);
    expect(validation.every((row) => row.status === 0)).toBe(true);
    expect(validation[0]?.args).toContain("--noEmit");
    expect(validation[1]?.args[0]).toContain("vitest.mjs");
    expect(validation[2]?.stdout).toContain("Held-out replay passed");
    expect(stages).toEqual([
      "installed-broken",
      "sdk-repair-test-double",
      "full-suite-and-held-out-passed",
      "installed-repaired",
      "published-tests-green",
    ]);
    const builds = envelopes.flatMap(({ event }) =>
      event.type === "game.build" ? [event] : [],
    );
    expect(builds.map((build) => build.buildId)).toEqual([broken.id, clean.id]);
    for (const artifact of [broken, clean] satisfies GameArtifact[]) {
      const response = await fetch(
        `${server.origin}/api/builds/${artifact.id}.js`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(artifact.code);
    }
    expect(installs).toHaveLength(2);
    for (const install of installs) {
      expect(install.after.frame).toBeGreaterThanOrEqual(install.before.frame);
      // The actual client checks identical object identity and JSON state bytes
      // immediately around each install, covering every field included in hash.
      expect(install.after.installs.every((item) => item.statePreserved)).toBe(
        true,
      );
      expect(install.after.hash).toMatch(/^[a-f0-9]{8}$/);
    }
    const snapshot = await client.snapshot();
    expect(snapshot.frame).toBeGreaterThan(installs[0]?.after.frame ?? 0);
    expect(snapshot.buildId).toBe(clean.id);
    expect(snapshot.broadcast).toMatchObject({
      bug: "fixed",
      chat: 0,
      codex: 1,
    });
    expect(snapshot.sdkSteps).toBe(0);
    expect(
      envelopes.filter(
        ({ event }) =>
          event.type === "overlay" && event.event.type === "score.changed",
      ),
    ).toHaveLength(1);
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual(
      envelopes.map((_, index) => index + 1),
    );
    const launches = (await readFile(adapterLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(launches).toHaveLength(4);
    expect(launches.every(({ args }) => args.includes("hotfix"))).toBe(true);
  } catch (error) {
    const diagnostic = await readFile(
      join(directory, "client.log"),
      "utf8",
    ).catch(() => "No client log");
    throw new Error(
      `Offline integration failed: ${String(error)}\n${diagnostic}`,
      { cause: error },
    );
  } finally {
    await engine?.stop();
    await delivery.catch(() => {});
    await server?.close();
    await client?.close();
    await workspace?.cleanup();
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
