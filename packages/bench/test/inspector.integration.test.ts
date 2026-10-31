import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { parseInspectorData } from "../../inspector-mcp/src/index.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { enumerateCandidates } from "../../mutator/src/live.js";
import { HELD_OUT, TRACKS } from "../../replay/src/index.js";
import { executeRepair } from "../../round/src/runtime-execution.js";
import { materializeInspector } from "../src/inspector.js";
import {
  createLauncher,
  inspectorProfile,
  loadProfile,
  permissionOverrides,
} from "../src/runtime.js";
import { buildTicket } from "../src/trial.js";
import {
  changedPaths,
  git,
  prepareWorkspace,
  snapshot,
} from "../src/workspace.js";

it("keeps the MCP process inside a strictly read-only hotfix profile with every deny intact", async () => {
  const original = await loadProfile();
  const readOnly = inspectorProfile(original);
  expect(readOnly).toBe(original.replace('"." = "write"', '"." = "read"'));
  expect(permissionOverrides(readOnly)[1]).toContain(
    '":workspace_roots" = { "." = "read", "test" = "read", "fixtures" = "read" }',
  );
  for (const deny of [
    '":root" = "deny"',
    '"/tmp" = "deny"',
    '"/private/tmp" = "deny"',
    '"/private/var/folders" = "deny"',
    "enabled = false",
  ])
    expect(readOnly).toContain(deny);
  expect(() => inspectorProfile(readOnly)).toThrow("exact workspace");
  expect(() => inspectorProfile(`${original}\n"." = "write"`)).toThrow(
    "exact workspace",
  );
  expect(original).toBe(await loadProfile());
});

it("streams a real Inspector stdio call before a fake CLI repair, then passes the actual full replay gate", async () => {
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { mutants: PooledMutant[] };
  const mutant = pool.mutants.find((item) => item.family === "gravity-sign");
  if (!mutant) throw new Error("No fixture mutant");
  const logs = await mkdtemp(join(tmpdir(), "inspector-proof-"));
  const workspace = await prepareWorkspace(mutant, undefined, true);
  try {
    const serialized = await readFile(
      join(workspace.game, "fixtures/inspector/traces.json"),
      "utf8",
    );
    const traces = parseInspectorData(JSON.parse(serialized));
    expect(traces.tracks.map((item) => item.name)).toEqual(
      TRACKS.map((_, index) => `replay-${String(index + 1).padStart(2, "0")}`),
    );
    for (const forbidden of [
      HELD_OUT.name,
      "held-out",
      "sourceDigest",
      mutant.family,
      mutant.id,
      "Math.min",
      "export function",
      "clean-flag",
    ])
      expect(serialized).not.toContain(forbidden);
    expect(git(workspace.game, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(
      git(workspace.game, ["show", "HEAD:fixtures/inspector/server.mjs"]),
    ).toContain("tools/list");
    expect(
      git(workspace.game, ["show", "HEAD:fixtures/inspector/traces.json"]),
    ).toBe(serialized);
    expect(await readdir(workspace.parent)).toEqual(["game"]);
    const bin = join(logs, "bin");
    await mkdir(bin);
    const adapter = join(bin, "codex");
    const calls = join(logs, "policy-adapter.jsonl");
    // The adapter asserts the exact sandbox command but offers no OS isolation.
    await build({
      entryPoints: [
        join(ROOT, "packages/bench/test/fixtures/inspector-policy-adapter.ts"),
      ],
      outfile: adapter,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: `#!${process.execPath}` },
      define: { CALLS_FILE: JSON.stringify(calls) },
    });
    await chmod(adapter, 0o700);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    const fake = join(logs, "fake-cli.mjs");
    const proof = join(logs, "mcp-proof.json");
    await build({
      entryPoints: [
        join(ROOT, "packages/bench/test/fixtures/inspector-cli.ts"),
      ],
      outfile: fake,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: `#!${process.execPath}` },
      define: {
        CLEAN_SOURCE: JSON.stringify(workspace.cleanSources["src/index.ts"]),
        PROOF_FILE: JSON.stringify(proof),
      },
    });
    await chmod(fake, 0o700);
    const launcher = join(logs, "launcher");
    await createLauncher(launcher, fake);
    const events: ThreadEvent[] = [];
    const observations: string[] = [];
    const artifact = await executeRepair(
      {
        workspace,
        launcher,
        profile: await loadProfile(),
        ticket: buildTicket(mutant),
        hint: null,
        model: "gpt-6.1-terra",
        effort: "low",
        logFile: join(logs, "events.jsonl"),
        budgetMs: 30000,
      },
      AbortSignal.timeout(30000),
      (event) => {
        events.push(event);
      },
      {},
      (observation) => {
        observations.push(observation.type);
      },
    );
    expect(artifact.replay?.frames).toHaveLength(600);
    expect(artifact.patch?.added).toBeGreaterThan(0);
    const types = events
      .filter((event) => event.type === "item.completed")
      .map((event) => event.item.type);
    expect(types).toContain("mcp_tool_call");
    expect(types).toContain("file_change");
    expect(types.indexOf("mcp_tool_call")).toBeLessThan(
      types.indexOf("file_change"),
    );
    expect(observations).toContain("runtime.replay");
    const data = JSON.parse(await readFile(proof, "utf8"));
    expect(data.beforePatch).toBe(true);
    expect(
      data.listed.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(["replay_frames", "first_divergence", "diff_telemetry"]);
    expect(JSON.parse(data.divergence.content[0].text).frame).toBe(
      mutant.evidence.find((item) => item.name === TRACKS[0]?.name)
        ?.firstDivergence,
    );
    expect(
      await readFile(
        join(workspace.game, "fixtures/inspector/traces.json"),
        "utf8",
      ),
    ).toBe(serialized);
    expect(
      changedPaths(workspace.before, await snapshot(workspace.game)),
    ).toEqual(["src/index.ts"]);
    const invocations = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations.map((row) => row.inspection)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    const privateEvents = (await readFile(join(logs, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      privateEvents.filter((event) => event.kind === "validation"),
    ).toHaveLength(3);
    expect(
      privateEvents
        .filter((event) => event.kind === "validation")
        .every((event) => event.status === 0),
    ).toBe(true);
    expect(
      privateEvents.some((event) => event.kind === "repair.verified"),
    ).toBe(true);
    await expect(materializeInspector(workspace.game, mutant)).rejects.toThrow(
      "original planted source",
    );
  } finally {
    vi.unstubAllEnvs();
    await workspace.cleanup();
    await rm(logs, { recursive: true, force: true });
  }
}, 30000);

it("records an exact newly enumerated original absent from the static pool while preserving byte guards", async () => {
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { mutants: PooledMutant[] };
  const base = pool.mutants.find((row) => row.family === "gravity-sign");
  const candidate = (await enumerateCandidates()).find(
    (row) =>
      row.site === "collision" &&
      row.replacement === "false" &&
      !pool.mutants.some((item) => item.id === row.id),
  );
  if (!base || !candidate) throw new Error("Missing nonpool original fixture");
  const mutant = { ...base, ...candidate };
  const workspace = await prepareWorkspace(mutant, undefined, true);
  try {
    const data = parseInspectorData(
      JSON.parse(
        await readFile(
          join(workspace.game, "fixtures/inspector/traces.json"),
          "utf8",
        ),
      ),
    );
    expect(data.tracks).toHaveLength(TRACKS.length);
    expect(git(workspace.game, ["rev-list", "--count", "HEAD"])).toBe("1");
  } finally {
    await workspace.cleanup();
  }
});
