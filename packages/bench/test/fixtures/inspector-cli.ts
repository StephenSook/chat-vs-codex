/** Fake CLI fixture only. Bundled outside the runtime workspace by the test. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

declare const CLEAN_SOURCE: string;
declare const PROOF_FILE: string;
const emit = (value: unknown) => console.log(JSON.stringify(value));
process.stdin.resume();
await once(process.stdin, "end");
const directory = process.argv[process.argv.indexOf("--cd") + 1];
if (!directory) throw new Error("Missing workspace");
process.chdir(directory);
const override = process.argv.find((arg) =>
  arg.startsWith("mcp_servers.game_inspector = "),
);
if (!override) throw new Error("Inspector not registered");
if (
  !override.includes("required = true") ||
  !override.includes("tool_timeout_sec = 5")
)
  throw new Error("Inspector must be required and bounded");
const fields = override.match(
  /command = ("(?:[^"\\]|\\.)*"), args = (\[[\s\S]*\]), cwd = ("(?:[^"\\]|\\.)*")/,
);
if (!fields) throw new Error("Missing Inspector stdio configuration");
const child = spawn(JSON.parse(fields[1] ?? ""), JSON.parse(fields[2] ?? ""), {
  cwd: JSON.parse(fields[3] ?? ""),
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
type Result = { content: { text: string }[]; isError: boolean };
const pending = new Map<
  number,
  {
    resolve: (value: Result) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const value = JSON.parse(line);
  const pair = pending.get(value.id);
  if (pair) {
    pending.delete(value.id);
    clearTimeout(pair.timer);
    if (value.error) pair.reject(new Error(value.error.message));
    else pair.resolve(value.result);
  }
});
let id = 0;
const rpc = (method: string, params: unknown): Promise<Result> =>
  new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(new Error("MCP timeout")), 4000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: key, method, params })}\n`,
    );
  });
let cleanClose = false;
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fixture-fake-cli", version: "1" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const listed = await rpc("tools/list", {});
  const divergence = await rpc("tools/call", {
    name: "first_divergence",
    arguments: { track: "replay-01" },
  });
  const frame = JSON.parse(divergence.content[0]?.text ?? "null").frame;
  const frames = await rpc("tools/call", {
    name: "replay_frames",
    arguments: { track: "replay-01", from: frame, to: frame },
  });
  const diff = await rpc("tools/call", {
    name: "diff_telemetry",
    arguments: { track: "replay-01", frame },
  });
  const hidden = await rpc("tools/call", {
    name: "first_divergence",
    arguments: { track: "held-out-delayed-start" },
  });
  if (divergence.isError || frames.isError || diff.isError || !hidden.isError)
    throw new Error("Inspector data failed");
  writeFileSync(
    PROOF_FILE,
    JSON.stringify({
      init,
      listed,
      divergence,
      frames,
      diff,
      hidden,
      beforePatch: readFileSync("src/index.ts", "utf8") !== CLEAN_SOURCE,
    }),
  );
  emit({ type: "thread.started", thread_id: "fixture-inspector" });
  emit({
    type: "item.completed",
    item: {
      id: "tool-1",
      type: "mcp_tool_call",
      server: "game_inspector",
      tool: "first_divergence",
      arguments: { track: "replay-01" },
      result: { content: divergence.content, structured_content: null },
      status: "completed",
    },
  });
} finally {
  const closed = once(child, "close");
  child.stdin.end();
  const [code, signal] = await closed;
  lines.close();
  cleanClose = code === 0 && !signal;
}
if (!cleanClose) throw new Error("Inspector did not close cleanly");
writeFileSync("src/index.ts", CLEAN_SOURCE);
emit({
  type: "item.completed",
  item: {
    id: "patch",
    type: "file_change",
    changes: [{ path: "src/index.ts", kind: "update" }],
    status: "completed",
  },
});
emit({
  type: "item.completed",
  item: {
    id: "answer",
    type: "agent_message",
    text: JSON.stringify({
      rootCause: "fixture repair",
      file: "src/index.ts",
      line: 1,
      explanation: "Restored the planted behavior.",
      headline: "Player falls toward the ground again",
      confidence: 1,
    }),
  },
});
emit({
  type: "turn.completed",
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
});
