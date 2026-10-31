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
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HELD_OUT, runTrack } from "../../replay/src/index.js";
import { loadProfile } from "../src/runtime.js";
import { validateWorkspace } from "../src/trial.js";
import {
  REPLAY_TRACE_PREFIX,
  type ValidatedReplay,
  type ValidatedReplayFrame,
  validatedReplay,
} from "../src/validated-replay.js";
import { prepareWorkspace, type TrialWorkspace } from "../src/workspace.js";

function trace(frames: unknown = runTrack(HELD_OUT).samples): string {
  return `Held-out replay passed\n${REPLAY_TRACE_PREFIX}${JSON.stringify(frames)}\n`;
}

describe("validated replay output parser", () => {
  it("binds the actual bounded samples to the held-out track and 60 Hz clock", () => {
    expect(validatedReplay(trace())).toEqual({
      fps: 60,
      trackDigest: createHash("sha256")
        .update(JSON.stringify(HELD_OUT))
        .digest("hex"),
      frames: runTrack(HELD_OUT).samples,
    });
  });

  it.each([
    ["absent", "Held-out replay passed\n"],
    ["duplicate", trace() + trace()],
    ["malformed JSON", `${REPLAY_TRACE_PREFIX}{\n`],
    ["non-array", trace({ frames: [] })],
    ["short budget", trace(runTrack(HELD_OUT).samples.slice(1))],
    [
      "oversized budget",
      trace([...runTrack(HELD_OUT).samples, runTrack(HELD_OUT).samples[0]]),
    ],
  ])("rejects %s evidence", (_name, output) => {
    expect(() => validatedReplay(output)).toThrow();
  });

  it.each([
    [
      "null frame",
      (frames: unknown[]) => {
        frames[0] = null;
      },
    ],
    [
      "out-of-order frame",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) frames[0].frame = 2;
      },
    ],
    [
      "noninteger position",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) frames[0].x = 0.5;
      },
    ],
    [
      "unsafe position",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) frames[0].y = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "invalid alive flag",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) Object.assign(frames[0], { alive: "true" });
      },
    ],
    [
      "invalid won flag",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) Object.assign(frames[0], { won: 0 });
      },
    ],
    [
      "invalid hash",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[0]) frames[0].stateHash = "not-a-hash";
      },
    ],
    [
      "checkpoint mismatch",
      (frames: ValidatedReplayFrame[]) => {
        if (frames[59]) frames[59].stateHash = "00000000";
      },
    ],
    [
      "outcome mismatch",
      (frames: ValidatedReplayFrame[]) => {
        const last = frames.at(-1);
        if (last) last.x++;
      },
    ],
  ])("rejects %s", (_name, corrupt) => {
    const frames = structuredClone(runTrack(HELD_OUT).samples);
    corrupt(frames);
    expect(() => validatedReplay(trace(frames))).toThrow();
  });
});

interface ValidationLog {
  kind: string;
  args: string[];
  status: number | null;
  stdout: string;
}

describe("real validator with an explicit test-only policy adapter", () => {
  it.each([false, true])(
    "collects only the same successful held-out execution (held-out-only failure=%s)",
    async (failHeldOut) => {
      const scratch = await mkdtemp(join(tmpdir(), "validated-replay-test-"));
      const originalPath = process.env.PATH;
      let workspace: TrialWorkspace | undefined;
      try {
        const executable = join(scratch, "codex");
        // This adapter invokes no SDK/model and proves no OS sandbox policy.
        // It delegates the real validator commands and checks their TMPDIR contract.
        await writeFile(
          executable,
          `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { statSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2), separator = args.indexOf('--');
const workspace = args[args.indexOf('--cd') + 1];
if (args[0] !== 'sandbox' || separator < 0 || !['TMPDIR','TMP','TEMP'].every(key => process.env[key] === join(workspace,'.tmp')) || !statSync(process.env.TMPDIR).isDirectory()) process.exit(72);
const result = spawnSync(args[separator+1], args.slice(separator+2), { stdio:'inherit', cwd:workspace, timeout:14000, killSignal:'SIGKILL' });
process.exit(result.error || result.signal ? 73 : result.status ?? 74);
`,
        );
        await chmod(executable, 0o700);
        process.env.PATH = `${scratch}:${originalPath ?? ""}`;
        workspace = await prepareWorkspace(null);
        for (const [path, source] of Object.entries(workspace.cleanSources)) {
          await readFile(join(workspace.game, path), "utf8");
          await writeFile(join(workspace.game, path), source);
        }
        if (failHeldOut) {
          const path = join(workspace.game, "src/index.ts");
          const source = await readFile(path, "utf8");
          const signature =
            "export function step(state: State, input: number): State {";
          expect(source.split(signature)).toHaveLength(2);
          await writeFile(
            path,
            source.replace(
              signature,
              `${signature}
  if (state.frame === 0 && input === 0 && JSON.stringify(state.rng) === JSON.stringify(createState(97).rng)) state = { ...state, jumps: state.jumps + 1 };`,
            ),
          );
        }
        const logs: ValidationLog[] = [];
        const onReplay = vi.fn(async (_replay: ValidatedReplay) => {
          await expect(
            stat(join(workspace?.game ?? "", "test/.held-out-check.mjs")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        });
        const started = performance.now();
        const validation = validateWorkspace(
          workspace,
          await loadProfile(),
          () => 25000 - (performance.now() - started),
          async (value) => {
            logs.push(value as ValidationLog);
          },
          onReplay,
        );
        if (failHeldOut) {
          await expect(validation).rejects.toThrow("Held-out replay failed");
          expect(onReplay).not.toHaveBeenCalled();
        } else {
          await validation;
          expect(onReplay).toHaveBeenCalledOnce();
          expect(onReplay.mock.calls[0]?.[0]).toEqual(validatedReplay(trace()));
        }
        expect(logs).toHaveLength(3);
        // Both real compilation and the entire visible replay suite ran green.
        expect(logs.slice(0, 2).map((entry) => entry.status)).toEqual([0, 0]);
        expect(logs[1]?.stdout).toContain("passed");
        expect(logs[2]?.status).toBe(failHeldOut ? 1 : 0);
        expect(logs[2]?.stdout.includes(REPLAY_TRACE_PREFIX)).toBe(
          !failHeldOut,
        );
        await expect(
          stat(join(workspace.game, "test/.held-out-check.mjs")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        await workspace?.cleanup();
        await rm(scratch, { recursive: true, force: true });
      }
    },
    30000,
  );
});
