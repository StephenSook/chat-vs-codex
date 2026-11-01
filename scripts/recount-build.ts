import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface LogRow {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    item?: {
      type?: string;
      status?: string;
      kind?: string;
      agent_thread_id?: string;
    };
  };
}

/** Counts event records through an exact completed turn; returns no transcript. */
export function recountBuild(source: Buffer | string, cutoff: string) {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("Invalid cutoff");
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Invalid UTF-8 log");
  const metrics = {
    completedTurns: 0,
    commandExecutions: 0,
    fileChanges: 0,
    subAgentStarts: 0,
    mcpCalls: 0,
  };
  const commandStatuses = { completed: 0, failed: 0 };
  const mcpStatuses = { completed: 0, failed: 0 };
  const agents = new Set<string>();
  let sessionId: string | undefined;
  let prefixBytes = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    prefixBytes += Buffer.byteLength(line);
    let row: LogRow;
    try {
      row = JSON.parse(line) as LogRow;
    } catch {
      throw new Error("Malformed session JSONL");
    }
    if (row.type === "session_meta") sessionId = row.payload?.id;
    if (row.type !== "event_msg") continue;
    const payload = row.payload;
    if (payload?.type === "item_completed") {
      const item = payload.item;
      if (item?.type === "CommandExecution" || item?.type === "McpToolCall") {
        if (item.status !== "completed" && item.status !== "failed")
          throw new Error("Unrecognized completed-item status");
        if (item.type === "CommandExecution") {
          metrics.commandExecutions++;
          commandStatuses[item.status]++;
        } else {
          metrics.mcpCalls++;
          mcpStatuses[item.status]++;
        }
      } else if (item?.type === "FileChange") metrics.fileChanges++;
      else if (item?.type === "SubAgentActivity" && item.kind === "started") {
        if (!item.agent_thread_id)
          throw new Error("Missing started-agent identity");
        metrics.subAgentStarts++;
        agents.add(item.agent_thread_id);
      }
    }
    if (payload?.type !== "task_complete") continue;
    metrics.completedTurns++;
    if (row.timestamp !== cutoff) continue;
    if (!sessionId) throw new Error("Missing session identity");
    return {
      schemaVersion: 1,
      sourceKind: "private Codex session JSONL event records",
      sessionId,
      cutoff,
      checkpointPrefixSha256: createHash("sha256")
        .update(bytes.subarray(0, prefixBytes))
        .digest("hex"),
      metrics,
      commandStatuses,
      mcpStatuses,
      distinctStartedAgents: agents.size,
    };
  }
  throw new Error("Exact completed-turn boundary not found");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [log, cutoff, extra] = process.argv.slice(2);
  if (!log || !cutoff || extra)
    throw new Error(
      "Use pnpm build:recount <private-log> <completed-turn-ISO>",
    );
  try {
    console.log(
      JSON.stringify(recountBuild(await readFile(log), cutoff), null, 2),
    );
  } catch {
    console.error(
      "Could not recount the supplied private log and completed-turn boundary.",
    );
    process.exitCode = 1;
  }
}
