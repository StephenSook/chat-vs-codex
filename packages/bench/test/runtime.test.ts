import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertCanary } from "../src/canary.js";
import {
  createLauncher,
  loadProfile,
  permissionOverrides,
  RUNTIME_FLAGS,
  runRuntime,
  runtimeEnvironment,
} from "../src/runtime.js";
import { isSandboxFailure, sandboxCommand } from "../src/trial.js";

it("pins the exact permission profile including all temporary-directory denies", async () => {
  const overrides = permissionOverrides(await loadProfile());
  expect(overrides).toEqual([
    'default_permissions = "hotfix"',
    'permissions.hotfix.filesystem = { ":root" = "deny", ":minimal" = "read", "/opt/homebrew" = "read", "/private/tmp" = "deny", "/tmp" = "deny", "/private/var/folders" = "deny", ":workspace_roots" = { "." = "write", "test" = "read", "fixtures" = "read" } }',
    "permissions.hotfix.network = { enabled = false }",
  ]);
  // Codex's override path splitter does not interpret quoted TOML dotted keys.
  for (const override of overrides)
    expect(override.slice(0, override.indexOf("="))).not.toMatch(/["/:]/);
  expect(() => permissionOverrides("[unexpected]\nenabled = false")).toThrow();
  const verifier = sandboxCommand(
    await loadProfile(),
    "/private/tmp/random/game",
    "/opt/homebrew/bin/node",
    ["test/check.mjs"],
  );
  expect(verifier).toEqual(expect.arrayContaining(overrides));
  expect(verifier).toContain("hotfix");
});

it("uses real SDK streaming, raw config overrides and stripped exec flags with a fake CLI", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sdk-contract-"));
  try {
    const fake = join(scratch, "fake-cli.mjs");
    const capture = join(scratch, "capture.json");
    const home = join(scratch, "empty-home");
    await mkdir(home);
    await writeFile(
      fake,
      `#!/usr/bin/env node
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),env:process.env}));
      process.stdin.resume();process.stdin.on('end',()=>{
        for(const event of [
          {type:'thread.started',thread_id:'contract'},
          {type:'item.completed',item:{type:'agent_message',id:'answer',text:JSON.stringify({rootCause:'test',file:'src/index.ts',line:1,explanation:'test',confidence:1})}},
          {type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:4,cache_write_input_tokens:0,output_tokens:2,reasoning_output_tokens:1}}
        ]) console.log(JSON.stringify(event));
      });
    `,
    );
    await chmod(fake, 0o700);
    const launcher = join(scratch, "launch");
    await createLauncher(launcher, fake);
    const events: string[] = [];
    const result = await runRuntime({
      workspace: scratch,
      home,
      launcher,
      profile: await loadProfile(),
      codexHome: "/real/auth/home",
      model: "gpt-6.1-terra",
      effort: "low",
      prompt: "test",
      signal: AbortSignal.timeout(3000),
      event: async (event) => {
        events.push(event.type);
      },
    });
    expect(result.usage).toEqual({
      input_tokens: 12,
      cached_input_tokens: 4,
      output_tokens: 2,
    });
    expect(events).toContain("turn.completed");
    const actual = JSON.parse(await readFile(capture, "utf8")) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(actual.args.slice(0, RUNTIME_FLAGS.length + 1)).toEqual([
      "exec",
      ...RUNTIME_FLAGS,
    ]);
    expect(actual.args).not.toContain("--sandbox");
    expect(actual.args).toContain("--output-schema");
    expect(actual.args).toContain('default_permissions = "hotfix"');
    expect(actual.args).toEqual(
      expect.arrayContaining(permissionOverrides(await loadProfile())),
    );
    expect(actual.env.HOME).toBe(home);
    expect(actual.env.CODEX_HOME).toBe("/real/auth/home");
    for (const key of ["TMPDIR", "TMP", "TEMP"])
      expect(actual.env[key]).toBe(join(await realpath(scratch), ".tmp"));
    expect((await stat(join(scratch, ".tmp"))).isDirectory()).toBe(true);
    expect(actual.env.OPENAI_API_KEY).toBeUndefined();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("uses the physical workspace temp path when the workspace has an alias", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "temp-alias-"));
  try {
    const game = join(scratch, "game");
    const alias = join(scratch, "alias");
    await mkdir(join(game, ".tmp"), { recursive: true });
    await symlink(game, alias);
    const environment = runtimeEnvironment(alias, scratch);
    for (const key of ["TMPDIR", "TMP", "TEMP"])
      expect(environment[key]).toBe(join(await realpath(game), ".tmp"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it("does not mistake the PATH-alias warning for a fatal sandbox denial", () => {
  expect(
    isSandboxFailure(
      "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\nError loading config.toml: data did not match any variant of untagged enum FilesystemPermissionToml",
    ),
  ).toBe(false);
  expect(
    isSandboxFailure("sandbox-exec: sandbox_apply: Operation not permitted"),
  ).toBe(true);
});

it("requires positive controls and actual permission denials for every canary", () => {
  const receipt = {
    workspaceWrite: true,
    testRead: true,
    tempDirectory: true,
    parent: "EPERM",
    hostSkills: "EPERM",
    testWrite: "EACCES",
    fixtureWrite: "EPERM",
    network: "EPERM",
  };
  expect(() => assertCanary(receipt)).not.toThrow();
  for (const key of Object.keys(receipt))
    expect(() => assertCanary({ ...receipt, [key]: "ALLOWED" })).toThrow();
  expect(() => assertCanary({ ...receipt, parent: "ENOENT" })).toThrow();
  expect(() => assertCanary({ ...receipt, network: "TIMEOUT" })).toThrow();
});
