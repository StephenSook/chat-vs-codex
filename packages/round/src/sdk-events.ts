import type { McpToolCallItem, ThreadEvent } from "@openai/codex-sdk";
import type {
  CodexStep,
  OverlayEvent,
} from "../../../apps/overlay/src/events.js";

interface ShellWords {
  commands: string[][];
  separators: string[];
}
/** Lex only for presentation; never execute or expose arguments in the HUD. */
function shellWords(script: string): ShellWords {
  const commands: string[][] = [[]];
  const separators: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  const flush = () => {
    if (word) {
      commands.at(-1)?.push(word);
      word = "";
    }
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index];
    if (char === undefined) break;
    if (char === "\\" && quote !== "'") {
      const next = script[index + 1];
      if (next !== undefined) {
        word += next;
        index++;
      }
    } else if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (";&|\n".includes(char)) {
      flush();
      const double =
        script[index + 1] === char && (char === "&" || char === "|");
      separators.push(double ? char + char : char);
      if (double) index++;
      commands.push([]);
    } else if (/\s/.test(char)) flush();
    else word += char;
  }
  flush();
  return { commands: commands.filter((command) => command.length), separators };
}

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
function commandStep(raw: string): CodexStep {
  let parsed = shellWords(raw);
  for (let depth = 0; depth < 3; depth++) {
    const words = parsed.commands[0];
    if (
      parsed.commands.length !== 1 ||
      !words ||
      !/^(?:sh|bash|zsh)$/.test(basename(words[0] ?? ""))
    )
      break;
    const flag = words.findIndex(
      (word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word),
    );
    const script = flag >= 0 ? words[flag + 1] : undefined;
    if (script === undefined) break;
    parsed = shellWords(script);
  }
  // Pipelines, semicolons and OR can mask a test failure. Do not attribute
  // their aggregate exit to any individual test process.
  if (parsed.separators.some((separator) => separator !== "&&"))
    return { kind: "activity", action: "command" };
  let tests = false;
  let edits = false;
  let replay = false;
  let discover = false;
  let path: string | undefined;
  for (const original of parsed.commands) {
    const words = [...original];
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
    const name = basename(words[0] ?? "");
    const args = words.slice(1);
    const runner =
      args[0] === "run" || args[0] === "exec" ? args.slice(1) : args;
    const informational = args.some((arg) =>
      ["--help", "-h", "--version", "-v", "list"].includes(arg),
    );
    if (
      !informational &&
      (name === "vitest" ||
        (name === "node" &&
          /(?:^|\/)vitest(?:\.mjs|\/vitest\.mjs)$/.test(args[0] ?? "")) ||
        (["pnpm", "npm"].includes(name) &&
          /^(?:test(?::[\w-]+)?|vitest)$/.test(runner[0] ?? "")))
    )
      tests = true;
    if (
      /^replay:[\w-]+$/.test(name) ||
      (["pnpm", "npm"].includes(name) &&
        /^replay:[\w-]+$/.test(runner[0] ?? ""))
    )
      replay = true;
    if (
      ["pwd", "ls", "find", "tree"].includes(name) ||
      (name === "rg" && args.includes("--files"))
    )
      discover = true;
    if (
      name === "apply_patch" ||
      (["sed", "perl"].includes(name) &&
        args.some((arg) => /^-[a-z]*i/.test(arg))) ||
      (/^(?:python[\d.]*|node)$/.test(name) &&
        args.some((arg) =>
          /(?:write_text|write_bytes|writeFile(?:Sync)?|\.write\(|open\([^\n]*['"](?:w|a)[+b]*['"])/.test(
            arg,
          ),
        ))
    )
      edits = true;
    if (
      ["cat", "head", "tail", "sed", "rg"].includes(name) &&
      !args.includes("--files")
    ) {
      const file = args.find(
        (arg) =>
          !arg.startsWith("-") && /\.(?:[cm]?tsx?|json|md|ya?ml)$/.test(arg),
      );
      const candidate = file ? basename(file) : undefined;
      if (candidate && /^[\w.-]{1,80}$/.test(candidate)) path ??= candidate;
      else path ??= "source";
    }
  }
  if (tests && edits) return { kind: "activity", action: "edit-test" };
  if (tests) return { kind: "tests" };
  if (edits) return { kind: "activity", action: "edit" };
  if (replay) return { kind: "replay" };
  if (path) return { kind: "reading", path };
  return { kind: "activity", action: discover ? "discover" : "command" };
}

/** Expose tool identifiers and allowlisted argument shapes, never raw text or results. */
function toolStep(item: McpToolCallItem): CodexStep {
  const args =
    item.arguments &&
    typeof item.arguments === "object" &&
    !Array.isArray(item.arguments)
      ? (item.arguments as Record<string, unknown>)
      : {};
  const path = args.path ?? args.file_path;
  if (/^(?:read|read_file|Read)$/.test(item.tool) && typeof path === "string") {
    const file = basename(path);
    if (/^[\w.-]{1,64}\.(?:[cm]?[jt]sx?|json|md)$/.test(file))
      return { kind: "reading", path: file };
  }
  if (
    item.tool === "exec_command" &&
    typeof (args.cmd ?? args.command) === "string"
  )
    return commandStep((args.cmd ?? args.command) as string);
  const frame = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3600;
  if (["game_inspector", "game-inspector"].includes(item.server)) {
    if (item.tool === "diff_telemetry" && frame(args.frame))
      return {
        kind: "tool",
        name: "Inspector",
        summary: `replay frame ${args.frame}`,
      };
    if (
      item.tool === "replay_frames" &&
      frame(args.from) &&
      frame(args.to) &&
      args.to >= args.from
    )
      return {
        kind: "tool",
        name: "Inspector",
        summary:
          args.from === args.to
            ? `replay frame ${args.from}`
            : `replay ${args.from}-${args.to}`,
      };
    if (item.tool === "first_divergence")
      return { kind: "tool", name: "Inspector", summary: "first divergence" };
  }
  return {
    kind: "tool",
    name: /^[A-Za-z0-9_.:-]{1,48}$/.test(item.tool) ? item.tool : "MCP",
  };
}

/** Every observed SDK item gets a category; free text, arguments and output stay private. */
export function sdkOverlayEvent(
  roundId: string,
  event: ThreadEvent,
  observedAtMs?: number,
): OverlayEvent | null {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  )
    return null;
  const item = event.item;
  let status: "running" | "done" | "failed" =
    event.type === "item.completed" ? "done" : "running";
  if ("status" in item)
    status =
      item.status === "failed"
        ? "failed"
        : item.status === "completed"
          ? "done"
          : "running";
  let step: CodexStep;
  switch (item.type) {
    case "command_execution":
      if (typeof item.exit_code === "number" && item.exit_code !== 0)
        status = "failed";
      step = commandStep(item.command);
      break;
    case "file_change":
      step = { kind: "activity", action: "edit" };
      break;
    case "mcp_tool_call":
      step = toolStep(item);
      if (item.error) status = "failed";
      break;
    case "agent_message":
      step = { kind: "activity", action: "respond" };
      break;
    case "reasoning":
      step = { kind: "activity", action: "reason" };
      break;
    case "web_search":
      step = { kind: "activity", action: "search" };
      break;
    case "todo_list":
      step = { kind: "activity", action: "plan" };
      break;
    case "error":
      step = { kind: "activity", action: "error" };
      status = "failed";
      break;
  }
  return {
    type: "codex.step",
    roundId,
    id: item.id,
    ...(observedAtMs === undefined ? {} : { startedAtMs: observedAtMs }),
    attempt: 1,
    total: 1,
    step,
    status,
  };
}
