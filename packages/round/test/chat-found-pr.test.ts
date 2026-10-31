import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  collectNewRegressions,
  createChatFoundPr,
  type RunCommand,
  runCommand,
} from "../../../scripts/chat-found-pr.js";

const roundId = "82589ac9-1b1b-4393-8085-9bed5d88ee2b";
const regressionPath = `chat-found/${roundId}.json`;
const receiptPath = `docs/rounds/${roundId}.json`;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-found-pr-test-"));
  directories.push(directory);
  const root = join(directory, "source");
  const remote = join(directory, "origin.git");
  await mkdir(root);
  const git = (...args: string[]) =>
    runCommand("git", args, { cwd: root, isolated: true });
  await git("init", "-b", "main");
  await git("config", "user.name", "Stephen Sookra");
  await git("config", "user.email", "test@example.invalid");
  await writeFile(join(root, ".gitignore"), ".local/\nnode_modules/\n");
  await writeFile(join(root, "README.md"), "Base\n");
  await git("add", ".gitignore", "README.md");
  await git("commit", "-m", "Initial source");
  await git("init", "--bare", remote);
  await git("remote", "add", "origin", remote);
  await git("push", "origin", "main");
  const calls: string[][] = [];
  let existing = false;
  let ciFailure = false;
  let prCreates = 0;
  const run: RunCommand = async (program, args, options) => {
    calls.push([program, ...args]);
    if (program === "git" && args[0] === "remote" && args[1] === "get-url")
      return "https://github.com/StephenSook/chat-vs-codex.git\n";
    if (program === "pnpm") {
      expect(args).toEqual(["ci:local"]);
      expect(options.isolated).toBe(true);
      expect(
        await readFile(join(options.cwd, regressionPath), "utf8"),
      ).toContain(roundId);
      if (ciFailure) throw new Error("CI rejected");
      return "All checks passed";
    }
    if (program === "gitleaks") return "No leaks";
    if (program === "gh") {
      if (args[1] === "list")
        return JSON.stringify(
          existing
            ? [{ url: "https://github.com/StephenSook/chat-vs-codex/pull/123" }]
            : [],
        );
      if (args[1] === "create") {
        const bodyFile = args[args.indexOf("--body-file") + 1];
        expect(bodyFile).toBeTruthy();
        const body = await readFile(bodyFile as string, "utf8");
        expect(body).toContain(roundId);
        expect(body).toContain("viewer-64e8151b950b82cd");
        expect(body).not.toContain("steve_sociall");
        prCreates++;
        existing = true;
        return "https://github.com/StephenSook/chat-vs-codex/pull/123\n";
      }
      throw new Error("Unexpected GH command");
    }
    return runCommand(program, args, { ...options, isolated: true });
  };
  const addEvidence = async () => {
    for (const path of [regressionPath, receiptPath]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(
        join(root, path),
        await readFile(new URL(`../../../${path}`, import.meta.url)),
      );
    }
  };
  return {
    root,
    remote,
    git,
    run,
    calls,
    addEvidence,
    setCiFailure: (value = true) => {
      ciFailure = value;
    },
    prCreates: () => prCreates,
  };
}

it("refuses no new files before any network or GH operation", async () => {
  const f = await fixture();
  await expect(createChatFoundPr({ root: f.root, run: f.run })).rejects.toThrow(
    "No new chat-found",
  );
  expect(
    f.calls.some(
      (call) =>
        call[0] === "gh" || call.includes("fetch") || call.includes("push"),
    ),
  ).toBe(false);
});

it("publishes one isolated, fully gated evidence commit and reuses its existing PR", async () => {
  const f = await fixture();
  await f.addEvidence();
  await writeFile(join(f.root, "README.md"), "Unrelated staged work\n");
  await f.git("add", "README.md");
  const before = await f.git("status", "--porcelain");
  const result = await createChatFoundPr({ root: f.root, run: f.run });
  expect(result.url).toBe(
    "https://github.com/StephenSook/chat-vs-codex/pull/123",
  );
  expect(result.existing).toBe(false);
  expect(await f.git("branch", "--show-current")).toBe("main\n");
  expect(await f.git("status", "--porcelain")).toBe(before);
  expect(
    (await f.git("diff", "--name-only", "main", `origin/${result.branch}`))
      .trim()
      .split("\n")
      .sort(),
  ).toEqual([regressionPath, receiptPath].sort());
  expect(
    await f.git("log", "-1", "--format=%B", `origin/${result.branch}`),
  ).not.toMatch(/Co-Authored-By|AI attribution/);
  expect(f.calls.findIndex((call) => call[0] === "pnpm")).toBeLessThan(
    f.calls.findIndex((call) => call.includes("commit")),
  );
  expect(f.calls.find((call) => call.includes("push"))).not.toContain(
    "--force",
  );
  const retry = await createChatFoundPr({ root: f.root, run: f.run });
  expect(retry.existing).toBe(true);
  expect(f.prCreates()).toBe(1);
});

it("accepts staged additions and preserves the original caller's index", async () => {
  const f = await fixture();
  await f.addEvidence();
  await f.git("add", regressionPath, receiptPath);
  const before = await f.git("diff", "--cached", "--binary");
  expect(await collectNewRegressions(f.root, f.run)).toHaveLength(1);
  await createChatFoundPr({ root: f.root, run: f.run });
  expect(await f.git("diff", "--cached", "--binary")).toBe(before);
});

it("rejects immutable tracked evidence modifications before networking", async () => {
  const f = await fixture();
  await f.addEvidence();
  await f.git("add", regressionPath, receiptPath);
  await f.git("commit", "-m", "Retain evidence");
  await writeFile(join(f.root, regressionPath), "changed");
  await expect(createChatFoundPr({ root: f.root, run: f.run })).rejects.toThrow(
    "immutable",
  );
  expect(f.calls.some((call) => call.includes("fetch"))).toBe(false);
});

it("rejects unsafe names, evidence symlinks and raw viewer credits", async () => {
  const f = await fixture();
  await f.addEvidence();
  const original = await readFile(join(f.root, regressionPath), "utf8");
  await writeFile(join(f.root, "chat-found/extra.txt"), "secret");
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "filename",
  );
  await rm(join(f.root, "chat-found/extra.txt"));
  await rm(join(f.root, regressionPath));
  await symlink(join(f.root, "README.md"), join(f.root, regressionPath));
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "symlinks",
  );
  await rm(join(f.root, regressionPath));
  await writeFile(join(f.root, regressionPath), original);
  const record = JSON.parse(original);
  record.viewer = "real_twitch_username";
  await writeFile(join(f.root, regressionPath), JSON.stringify(record));
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "metadata",
  );
});

it("requires the exact regression digest and strips no unreviewed receipt metadata", async () => {
  const f = await fixture();
  await f.addEvidence();
  const receipt = JSON.parse(await readFile(join(f.root, receiptPath), "utf8"));
  receipt.autopsy.regressionTest.digest = "a".repeat(64);
  await writeFile(join(f.root, receiptPath), JSON.stringify(receipt));
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "hash-bound",
  );
  await f.addEvidence();
  const unsafe = JSON.parse(await readFile(join(f.root, receiptPath), "utf8"));
  unsafe.autopsy.displayNames = { breaker: "real_twitch_username" };
  await writeFile(join(f.root, receiptPath), JSON.stringify(unsafe));
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "Unexpected public",
  );
});

it("retains a failed isolated worktree and never commits or pushes after CI rejection", async () => {
  const f = await fixture();
  await f.addEvidence();
  f.setCiFailure();
  await expect(createChatFoundPr({ root: f.root, run: f.run })).rejects.toThrow(
    "isolated worktree retained",
  );
  expect(
    f.calls.some(
      (call) =>
        call.includes("commit") ||
        call.includes("push") ||
        (call[0] === "gh" && call[2] === "create"),
    ),
  ).toBe(false);
  expect(await f.git("branch", "--show-current")).toBe("main\n");
});

it("refuses an unexpected remote before fetching or creating a PR", async () => {
  const f = await fixture();
  await f.addEvidence();
  const run: RunCommand = (program, args, options) =>
    program === "git" && args[0] === "remote" && args[1] === "get-url"
      ? Promise.resolve("git@github.com:someone/another-project.git\n")
      : f.run(program, args, options);
  await expect(createChatFoundPr({ root: f.root, run })).rejects.toThrow(
    "Origin must be",
  );
  expect(
    f.calls.some((call) => call.includes("fetch") || call[0] === "gh"),
  ).toBe(false);
});

it("rejects CI that mutates selected evidence instead of committing unvalidated bytes", async () => {
  const f = await fixture();
  await f.addEvidence();
  const run: RunCommand = async (program, args, options) => {
    const result = await f.run(program, args, options);
    if (program === "pnpm")
      await writeFile(
        join(options.cwd, regressionPath),
        "changed after validation",
      );
    return result;
  };
  await expect(createChatFoundPr({ root: f.root, run })).rejects.toThrow(
    "CI modified selected evidence",
  );
  expect(
    f.calls.some((call) => call.includes("commit") || call.includes("push")),
  ).toBe(false);
});

it("verifies a landed push and reuses a PR when transport reports failure after delivery", async () => {
  const f = await fixture();
  await f.addEvidence();
  let pushReportedFailure = false;
  let prReportedFailure = false;
  const run: RunCommand = async (program, args, options) => {
    const result = await f.run(program, args, options);
    if (program === "git" && args.includes("push") && !pushReportedFailure) {
      pushReportedFailure = true;
      throw new Error("Push response lost");
    }
    if (program === "gh" && args[1] === "create" && !prReportedFailure) {
      prReportedFailure = true;
      throw new Error("PR response lost");
    }
    return result;
  };
  expect((await createChatFoundPr({ root: f.root, run })).url).toBe(
    "https://github.com/StephenSook/chat-vs-codex/pull/123",
  );
  expect(f.prCreates()).toBe(1);
  expect(f.calls.some((call) => call.includes("ls-remote"))).toBe(true);
});

it("retries after a real CI rejection without leaving a local branch lock", async () => {
  const f = await fixture();
  await f.addEvidence();
  f.setCiFailure();
  await expect(createChatFoundPr({ root: f.root, run: f.run })).rejects.toThrow(
    "CI rejected",
  );
  expect((await f.git("branch", "--list", "chat-found/*")).trim()).toBe("");
  f.setCiFailure(false);
  expect((await createChatFoundPr({ root: f.root, run: f.run })).url).toContain(
    "/pull/123",
  );
  expect(f.prCreates()).toBe(1);
});

it("retries after a genuine PR creation rejection by reusing the exact remote evidence commit", async () => {
  const f = await fixture();
  await f.addEvidence();
  let rejectCreate = true;
  const run: RunCommand = async (program, args, options) => {
    if (program === "gh" && args[1] === "create" && rejectCreate)
      throw new Error("GitHub temporarily refused PR creation");
    return f.run(program, args, options);
  };
  await expect(createChatFoundPr({ root: f.root, run })).rejects.toThrow(
    "GitHub temporarily refused",
  );
  const push = f.calls.find((call) => call.includes("push"));
  const ref = push?.at(-1)?.replace(/^HEAD:/, "");
  expect(ref).toBeTruthy();
  const previous = (
    await f.git("ls-remote", "--heads", "origin", ref as string)
  ).split(/\s+/)[0];
  expect((await f.git("branch", "--list", "chat-found/*")).trim()).toBe("");
  rejectCreate = false;
  const result = await createChatFoundPr({ root: f.root, run });
  expect(result.url).toContain("/pull/123");
  expect(
    (await f.git("ls-remote", "--heads", "origin", ref as string)).split(
      /\s+/,
    )[0],
  ).toBe(previous);
  expect(f.calls.filter((call) => call.includes("commit"))).toHaveLength(1);
  expect(f.calls.filter((call) => call[0] === "pnpm")).toHaveLength(2);
  expect(f.prCreates()).toBe(1);
});

it("accepts input enums on public receipts and refuses names in their place", async () => {
  const f = await fixture();
  await f.addEvidence();
  const receipt = JSON.parse(await readFile(join(f.root, receiptPath), "utf8"));
  receipt.input = "channel-points";
  receipt.autopsy.input = "channel-points";
  await writeFile(join(f.root, receiptPath), JSON.stringify(receipt));
  expect(await collectNewRegressions(f.root, f.run)).toHaveLength(1);
  receipt.input = "real_twitch_username";
  await writeFile(join(f.root, receiptPath), JSON.stringify(receipt));
  await expect(collectNewRegressions(f.root, f.run)).rejects.toThrow(
    "recognized enum",
  );
});
