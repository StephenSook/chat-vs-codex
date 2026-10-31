import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseRegression } from "../packages/bench/src/regressions.js";
import {
  isRoundInput,
  validBossReceipt,
  validMachineLoad,
} from "../packages/round/src/contracts.js";
import type { publicReceipt } from "../packages/round/src/receipt.js";
import {
  deriveSeason,
  type SeasonReceipt,
} from "../packages/round/src/season.js";
import { recordSeason } from "../packages/round/src/season-store.js";

const REPOSITORY = "StephenSook/chat-vs-codex";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const REGRESSION_PATH = new RegExp(`^chat-found/(${UUID})\\.json$`);
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type Receipt = ReturnType<typeof publicReceipt>;
export type RunCommand = (
  program: string,
  args: readonly string[],
  options: { cwd: string; isolated?: boolean },
) => Promise<string>;

export const runCommand: RunCommand = async (program, args, options) => {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true" };
  if (options.isolated) {
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
  }
  const result = await promisify(execFile)(program, [...args], {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return result.stdout;
};

async function confinedFile(root: string, path: string): Promise<Buffer> {
  if (!new RegExp(`^(?:chat-found|docs/rounds)/${UUID}\\.json$`).test(path))
    throw new Error("Unsafe evidence path");
  const file = join(root, path);
  for (const part of path
    .split("/")
    .map((_, index, parts) => join(root, ...parts.slice(0, index + 1))))
    if ((await lstat(part)).isSymbolicLink())
      throw new Error("Evidence symlinks are refused");
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(file);
  if (
    !canonical.startsWith(`${canonicalRoot}${sep}`) ||
    !(await lstat(file)).isFile()
  )
    throw new Error("Evidence must be a regular file inside this repository");
  const bytes = await readFile(file);
  if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024)
    throw new Error("Evidence byte budget exceeded");
  return bytes;
}

/** Public receipt keys only. Unknown identity fields cannot hitchhike into a PR. */
const RECEIPT_KEYS = new Set([
  "machine",
  "load1m",
  "coreCount",
  "busy",
  "boss",
  "memory",
  "threads",
  "freeBytes",
  "availableBytes",
  "rssBytes",
  "minimumFreeBytes",
  "measuredAtMs",
  "timings",
  "threadStartedAtMs",
  "patchReadyAtMs",
  "validationStartedAtMs",
  "validationFinishedAtMs",
  "failure",
  "schemaVersion",
  "mutation",
  "roundId",
  "trigger",
  "input",
  "mode",
  "fixture",
  "model",
  "effort",
  "breaker",
  "firstCorrectGuesser",
  "validationReplay",
  "autopsy",
  "family",
  "winner",
  "reason",
  "scores",
  "clock",
  "timingVersion",
  "durations",
  "timingDefinition",
  "completedAt",
  "events",
  "verification",
  "path",
  "sourceDigest",
  "candidateDigest",
  "enumerated",
  "eligible",
  "attempted",
  "budgetMs",
  "elapsedMs",
  "gates",
  "typecheck",
  "differentMinifiedOutput",
  "killed",
  "visible",
  "frameBudget",
  "processBudgetMs",
  "canaryFrames",
  "trackDigest",
  "buildDigest",
  "frameCount",
  "framesDigest",
  "status",
  "patch",
  "explanation",
  "headline",
  "previousRoundId",
  "deltaMs",
  "regressionTest",
  "regressionError",
  "added",
  "removed",
  "preview",
  "digest",
  "headStartMs",
  "repairMs",
  "validationMs",
  "swapMs",
  "timeToGreenMs",
  "chat",
  "codex",
  "sequence",
  "type",
  "phase",
  "atMs",
  "wallTime",
  "fullReplaySuite",
  "heldOutReplay",
  "statePreserved",
  "finalStateHash",
  "builds",
  "frame",
]);
function publicFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) publicFields(child);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (!RECEIPT_KEYS.has(key))
      throw new Error("Unexpected public receipt metadata");
    if (
      ["breaker", "firstCorrectGuesser"].includes(key) &&
      child !== null &&
      (typeof child !== "string" || !/^viewer-[a-f0-9]{16}$/.test(child))
    )
      throw new Error("Public receipt credits must be hashed viewer labels");
    if (key === "input" && !isRoundInput(child))
      throw new Error("Public receipt input must be a recognized enum");
    if (key === "machine" && !validMachineLoad(child))
      throw new Error("Invalid machine load receipt metadata");
    if (key === "boss" && !validBossReceipt(child))
      throw new Error("Invalid boss receipt metadata");
    publicFields(child);
  }
}

export async function collectNewRegressions(
  root: string,
  run: RunCommand = runCommand,
) {
  const git = (...args: string[]) => run("git", args, { cwd: root });
  const changes = (
    await git(
      "diff",
      "--no-renames",
      "--name-status",
      "-z",
      "HEAD",
      "--",
      "chat-found",
      "docs/rounds",
    )
  )
    .split("\0")
    .filter(Boolean);
  for (let i = 0; i < changes.length; i += 2)
    if (changes[i] !== "A")
      throw new Error(
        "Existing round evidence is immutable; refusing tracked modifications",
      );
  const names = new Set(
    [
      ...(
        await git(
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          "chat-found",
        )
      ).split("\0"),
      ...(
        await git(
          "diff",
          "--cached",
          "--name-only",
          "--diff-filter=A",
          "-z",
          "--",
          "chat-found",
        )
      ).split("\0"),
    ].filter(Boolean),
  );
  if (!names.size)
    throw new Error(
      "No new chat-found regression files; no network or PR operation was attempted.",
    );
  const records = [];
  for (const path of [...names].sort()) {
    const roundId = REGRESSION_PATH.exec(path)?.[1];
    if (!roundId) throw new Error("Unsafe chat-found filename");
    const bytes = await confinedFile(root, path);
    const regression = parseRegression(JSON.parse(bytes.toString("utf8")));
    if (regression.roundId !== roundId)
      throw new Error("Regression filename does not match its round");
    const receiptPath = `docs/rounds/${roundId}.json`;
    const receiptBytes = await confinedFile(root, receiptPath);
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as Receipt;
    publicFields(receipt);
    const binding = receipt.autopsy?.regressionTest;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.roundId !== roundId ||
      receipt.breaker !== regression.viewer ||
      receipt.autopsy?.roundId !== roundId ||
      receipt.autopsy.status !== "verified" ||
      receipt.autopsy.breaker !== regression.viewer ||
      receipt.verification?.fullReplaySuite !== true ||
      receipt.verification.heldOutReplay !== true ||
      receipt.verification.statePreserved !== true ||
      binding?.path !== path ||
      binding.digest !== hash(bytes)
    )
      throw new Error(
        "Regression is not hash-bound to its verified sanitized round receipt",
      );
    records.push({
      roundId,
      viewer: regression.viewer,
      createdAt: regression.createdAt,
      files: [
        { path, bytes },
        { path: receiptPath, bytes: receiptBytes },
      ],
    });
  }
  return records;
}

/** The caller's index and branch remain untouched, including unrelated staged work. */
export async function createChatFoundPr(
  options: { root?: string; run?: RunCommand } = {},
) {
  const root = resolve(
    options.root ??
      dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
  );
  const run = options.run ?? runCommand;
  const records = await collectNewRegressions(root, run);
  const git = (...args: string[]) => run("git", args, { cwd: root });
  const remote = (await git("remote", "get-url", "origin")).trim();
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:)StephenSook\/chat-vs-codex(?:\.git)?$/.test(
      remote,
    )
  )
    throw new Error(
      "Origin must be StephenSook/chat-vs-codex; refusing to push elsewhere",
    );
  await git("fetch", "origin", "main:refs/remotes/origin/main");
  const base = (await git("rev-parse", "origin/main")).trim();
  const fingerprint = hash(
    JSON.stringify(
      records.map((record) => [
        record.roundId,
        ...record.files.map((file) => hash(file.bytes)),
      ]),
    ),
  ).slice(0, 12);
  const date = new Date(
    Math.max(...records.map((record) => Date.parse(record.createdAt))),
  )
    .toISOString()
    .slice(0, 10);
  const branch = `chat-found/${date}-${fingerprint}`;
  const existingPr = async (): Promise<string | null> => {
    const rows = JSON.parse(
      await run(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          REPOSITORY,
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "url",
        ],
        { cwd: root },
      ),
    ) as { url: string }[];
    if (
      !Array.isArray(rows) ||
      rows.length > 1 ||
      rows.some(
        (row) =>
          !/^https:\/\/github\.com\/StephenSook\/chat-vs-codex\/pull\/\d+$/.test(
            row.url,
          ),
      )
    )
      throw new Error(
        "GitHub returned ambiguous or invalid pull request metadata",
      );
    return rows[0]?.url ?? null;
  };
  const existing = await existingPr();
  if (existing)
    return {
      url: existing,
      branch,
      existing: true,
      rounds: records.map((record) => record.roundId),
    };
  const files = records.flatMap((record) => record.files);
  const paths: string[] = [];
  for (const file of files) {
    if ((await git("ls-tree", "--name-only", base, "--", file.path)).trim()) {
      if (
        (await git("show", `${base}:${file.path}`)) !==
        file.bytes.toString("utf8")
      )
        throw new Error(
          "Remote round evidence differs; refusing to replace immutable evidence",
        );
    } else paths.push(file.path);
  }
  if (!paths.some((path) => path.startsWith("chat-found/")))
    throw new Error("No new regressions remain after fetching origin/main");
  // Derive the aggregate from fetched, committed receipts plus this exact batch.
  // The caller's unrelated receipts and working-tree season never enter the PR.
  const seasonReceipts = new Map<string, SeasonReceipt>();
  const baseReceipts = (
    await git("ls-tree", "-r", "--name-only", base, "--", "docs/rounds")
  )
    .split("\n")
    .filter((path) => new RegExp(`^docs/rounds/${UUID}\\.json$`).test(path));
  for (const path of baseReceipts) {
    const row = JSON.parse(
      await git("show", `${base}:${path}`),
    ) as SeasonReceipt;
    seasonReceipts.set(row.roundId, row);
  }
  for (const record of records) {
    const receiptFile = record.files.find((file) =>
      file.path.startsWith("docs/rounds/"),
    );
    if (!receiptFile) throw new Error("Missing selected round receipt");
    const row = JSON.parse(receiptFile.bytes.toString("utf8")) as SeasonReceipt;
    seasonReceipts.set(row.roundId, row);
  }
  const seasonFile = {
    path: "docs/season.json",
    bytes: Buffer.from(
      `${JSON.stringify(deriveSeason([...seasonReceipts.values()]), null, 2)}\n`,
    ),
  };
  files.push(seasonFile);
  const hasSeason = (
    await git("ls-tree", "--name-only", base, "--", seasonFile.path)
  ).trim();
  if (
    !hasSeason ||
    (await git("show", `${base}:${seasonFile.path}`)) !==
      seasonFile.bytes.toString("utf8")
  )
    paths.push(seasonFile.path);
  const remoteRef = `refs/heads/${branch}`;
  const advertised = (
    await git("ls-remote", "--heads", "origin", remoteRef)
  ).trim();
  let previousCommit: string | undefined;
  if (advertised) {
    const fields = advertised.split(/\s+/);
    if (
      fields.length !== 2 ||
      !/^[a-f0-9]{40}$/.test(fields[0] ?? "") ||
      fields[1] !== remoteRef
    )
      throw new Error("Unexpected remote batch branch metadata");
    await git("fetch", "origin", remoteRef);
    previousCommit = (await git("rev-parse", "FETCH_HEAD")).trim();
    if (previousCommit !== fields[0])
      throw new Error("Remote batch branch moved while fetching");
    const parents = (
      await git("rev-list", "--parents", "-n", "1", previousCommit)
    )
      .trim()
      .split(/\s+/);
    const changed = (
      await git("diff", "--name-only", "-z", base, previousCommit)
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    if (
      JSON.stringify(parents) !== JSON.stringify([previousCommit, base]) ||
      JSON.stringify(changed) !== JSON.stringify([...paths].sort())
    )
      throw new Error(
        "Existing remote batch has a different base or file set; refusing to replace it",
      );
    for (const file of files)
      if (
        (await git("show", `${previousCommit}:${file.path}`)) !==
        file.bytes.toString("utf8")
      )
        throw new Error(
          "Existing remote batch evidence bytes differ; refusing to replace it",
        );
  }
  const prefix = join(root, ".local");
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(prefix, "chat-found-pr-"));
  const worktree = join(directory, "game");
  await git("worktree", "add", "--detach", worktree, previousCommit ?? base);
  const command = (program: string, args: string[]) =>
    run(program, args, { cwd: worktree, isolated: true });
  const localGit = (...args: string[]) => command("git", args);
  try {
    if (!previousCommit)
      for (const file of files.filter((file) => paths.includes(file.path))) {
        await mkdir(dirname(join(worktree, file.path)), { recursive: true });
        await writeFile(join(worktree, file.path), file.bytes, {
          flag: file.path === "docs/season.json" ? "w" : "wx",
          mode: 0o644,
        });
      }
    await recordSeason(worktree, true);
    const expectedTrackedChanges = await localGit(
      "diff",
      "--name-only",
      "HEAD",
    );
    await command("pnpm", ["ci:local"]);
    if (
      (await localGit("diff", "--name-only", "HEAD")) !== expectedTrackedChanges
    )
      throw new Error(
        "CI modified tracked source; refusing to publish a different tree",
      );
    for (const file of files)
      if (!(await readFile(join(worktree, file.path))).equals(file.bytes))
        throw new Error(
          "CI modified selected evidence; refusing to publish different bytes",
        );
    if (!previousCommit) {
      await localGit("add", "--", ...paths);
      const staged = (await localGit("diff", "--cached", "--name-only", "-z"))
        .split("\0")
        .filter(Boolean)
        .sort();
      if (JSON.stringify(staged) !== JSON.stringify([...paths].sort()))
        throw new Error("Unexpected staged files in isolated worktree");
      await command("gitleaks", [
        "git",
        "--pre-commit",
        "--staged",
        "--redact",
        "--no-banner",
      ]);
      await localGit(
        "commit",
        "-m",
        `Retain ${records.length} chat-found regression replay${records.length === 1 ? "" : "s"}`,
      );
    } else {
      await command("gitleaks", [
        "git",
        `--log-opts=${base}..${previousCommit}`,
        "--redact",
        "--no-banner",
      ]);
    }
    const changed = (await localGit("diff", "--name-only", "-z", base, "HEAD"))
      .split("\0")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...paths].sort()))
      throw new Error("Committed tree does not match selected evidence");
    const commit = (await localGit("rev-parse", "HEAD")).trim();
    try {
      await localGit(
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "-u",
        "origin",
        `HEAD:refs/heads/${branch}`,
      );
    } catch (error) {
      const landed = (
        await localGit("ls-remote", "--heads", "origin", `refs/heads/${branch}`)
      ).split(/\s+/)[0];
      if (landed !== commit) throw error;
    }
    const body = join(directory, "pr-body.md");
    await writeFile(
      body,
      `Adds ${records.length} verified regression replay${records.length === 1 ? "" : "s"} and its round evidence. Credits use hashed viewer labels.\n\n${records.map((record) => `- Round \`${record.roundId}\`: \`${record.viewer}\` ([receipt](https://github.com/${REPOSITORY}/blob/${branch}/docs/rounds/${record.roundId}.json))`).join("\n")}\n\nValidation: frozen install, typecheck, lint, tests and evidence secret scan passed.\n`,
      { mode: 0o600 },
    );
    let url: string;
    try {
      url = (
        await run(
          "gh",
          [
            "pr",
            "create",
            "--repo",
            REPOSITORY,
            "--base",
            "main",
            "--head",
            branch,
            "--title",
            `Chat found: ${records.length} regression replay${records.length === 1 ? "" : "s"}`,
            "--body-file",
            body,
          ],
          { cwd: root },
        )
      ).trim();
    } catch (error) {
      const found = await existingPr();
      if (!found) throw error;
      url = found;
    }
    if (
      !/^https:\/\/github\.com\/StephenSook\/chat-vs-codex\/pull\/\d+$/.test(
        url,
      )
    )
      throw new Error("GitHub returned no valid pull request URL");
    if ((await localGit("status", "--porcelain")).trim())
      throw new Error(
        "Isolated worktree changed after commit; retained for inspection",
      );
    await git("worktree", "remove", worktree);
    return {
      url,
      branch,
      existing: false,
      rounds: records.map((record) => record.roundId),
    };
  } catch (error) {
    throw new Error(
      `Chat-found PR stopped; isolated worktree retained at ${worktree}. ${error instanceof Error ? error.message : "Command failed"}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 2) throw new Error("Use pnpm chat-found:pr");
  console.log((await createChatFoundPr()).url);
}
