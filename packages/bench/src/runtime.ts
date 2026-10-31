import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import type { ModelSpec, TrialResult } from "./statistics.js";

export const RUNTIME_FLAGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  ...[
    "plugins",
    "hooks",
    "skill_search",
    "apps",
    "browser_use",
    "computer_use",
  ].flatMap((f) => ["--disable", f]),
];

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rootCause", "file", "line", "explanation", "confidence"],
  properties: {
    rootCause: { type: "string", minLength: 1 },
    file: { type: "string", minLength: 1 },
    line: { type: "integer", minimum: 1 },
    explanation: { type: "string", minLength: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/** Keep quoted path keys inside TOML values, outside the CLI's dotted-key parser. */
export function permissionOverrides(profile: string): string[] {
  let table = "";
  const sections = new Map<string, string[]>([
    ["", []],
    ["permissions.hotfix.filesystem", []],
    ['permissions.hotfix.filesystem.":workspace_roots"', []],
    ["permissions.hotfix.network", []],
  ]);
  for (const raw of profile.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      table = line.slice(1, -1);
      if (!sections.has(table)) throw new Error("Unexpected permission table");
      continue;
    }
    if (!/^(("[^"]+")|[a-z_]+)\s*=\s*("[^"]+"|false)$/.test(line))
      throw new Error("Unexpected permission profile syntax");
    sections.get(table)?.push(line);
  }
  const filesystem = sections.get("permissions.hotfix.filesystem") ?? [];
  const workspace =
    sections.get('permissions.hotfix.filesystem.":workspace_roots"') ?? [];
  const network = sections.get("permissions.hotfix.network") ?? [];
  if (!filesystem.length || !workspace.length || !network.length)
    throw new Error("Incomplete permission profile");
  return [
    ...(sections.get("") ?? []),
    `permissions.hotfix.filesystem = { ${filesystem.join(", ")}, ":workspace_roots" = { ${workspace.join(", ")} } }`,
    `permissions.hotfix.network = { ${network.join(", ")} }`,
  ];
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** SDK 0.163 supports -c overrides, but not these exec flags. A thin exec shim adds them. */
export async function createLauncher(
  path: string,
  executable?: string,
): Promise<void> {
  const real =
    executable ?? execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  if (!real.startsWith("/"))
    throw new Error("Codex executable must be absolute");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `#!/bin/sh\nset -eu\n[ "$1" = exec ] || exit 64\nshift\nexec ${shellQuote(real)} exec ${RUNTIME_FLAGS.map(shellQuote).join(" ")} "$@"\n`,
  );
  await chmod(path, 0o700);
}

export interface RuntimeOptions extends ModelSpec {
  workspace: string;
  home: string;
  launcher: string;
  profile: string;
  signal: AbortSignal;
  prompt: string;
  event: (event: ThreadEvent) => Promise<void>;
  codexHome?: string;
}

export async function runRuntime(options: RuntimeOptions): Promise<{
  usage: TrialResult["usage"];
  answer: TrialResult["answer"];
}> {
  const codex = new Codex({
    codexPathOverride: options.launcher,
    configOverrides: permissionOverrides(options.profile),
    env: {
      PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: options.home,
      CODEX_HOME:
        options.codexHome ??
        process.env.CODEX_HOME ??
        join(homedir(), ".codex"),
    },
  });
  const thread = codex.startThread({
    workingDirectory: options.workspace,
    model: options.model,
    modelReasoningEffort: options.effort,
    approvalPolicy: "never",
    webSearchMode: "disabled",
    // Deliberately no sandboxMode or additionalDirectories. The hotfix profile is authoritative.
  });
  const { events } = await thread.runStreamed(options.prompt, {
    signal: options.signal,
    outputSchema: ANSWER_SCHEMA,
  });
  let usage: TrialResult["usage"] = null;
  let text = "";
  let completed = false;
  for await (const event of events) {
    await options.event(event);
    if (event.type === "item.completed" && event.item.type === "agent_message")
      text = event.item.text;
    if (event.type === "turn.completed") {
      usage = {
        input_tokens: event.usage.input_tokens,
        cached_input_tokens: event.usage.cached_input_tokens,
        output_tokens: event.usage.output_tokens,
      };
      completed = true;
    }
    if (event.type === "turn.failed") throw new Error(event.error.message);
    if (event.type === "error") throw new Error(event.message);
  }
  if (!completed || !usage)
    throw new Error("Runtime ended without turn.completed usage");
  const answer: unknown = JSON.parse(text);
  if (!answer || typeof answer !== "object")
    throw new Error("Missing structured final answer");
  const value = answer as Record<string, unknown>;
  if (
    Object.keys(value).sort().join() !==
      "confidence,explanation,file,line,rootCause" ||
    !["rootCause", "file", "explanation"].every(
      (k) => typeof value[k] === "string" && String(value[k]).trim().length > 0,
    ) ||
    !Number.isSafeInteger(value.line) ||
    Number(value.line) < 1 ||
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new Error("Invalid structured final answer");
  }
  return { usage, answer: answer as NonNullable<TrialResult["answer"]> };
}

export async function loadProfile(): Promise<string> {
  return readFile(new URL("../hotfix.toml", import.meta.url), "utf8");
}
