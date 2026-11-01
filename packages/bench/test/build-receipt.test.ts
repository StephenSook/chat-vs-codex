import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recountBuild } from "../../../scripts/recount-build.js";

// Schema-shaped test doubles contain no private transcript content.
const early = "2026-01-01T00:00:01.000Z";
const late = "2026-01-01T00:00:02.000Z";
const event = (type: string, item?: object) => ({
  type: "event_msg",
  timestamp: early,
  payload: { type, item },
});
const item = (type: string, extra = {}) =>
  event("item_completed", { type, ...extra });
const meta = { type: "session_meta", payload: { id: "test-double-session" } };
const done = (timestamp: string) => ({ ...event("task_complete"), timestamp });
const jsonl = (...rows: object[]) =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

describe("private build event recount", () => {
  it("counts failures as attempts, file events, and starts rather than interactions", () => {
    const source = jsonl(
      meta,
      item("CommandExecution", { status: "completed" }),
      item("CommandExecution", { status: "failed" }),
      item("FileChange"),
      item("FileChange"),
      item("SubAgentActivity", { kind: "started", agent_thread_id: "agent-a" }),
      item("SubAgentActivity", {
        kind: "completed",
        agent_thread_id: "agent-a",
      }),
      item("SubAgentActivity", {
        kind: "interacted",
        agent_thread_id: "agent-a",
      }),
      item("McpToolCall", { status: "completed" }),
      item("McpToolCall", { status: "failed" }),
      done(early),
    );
    const result = recountBuild(source, early);
    expect(result.metrics).toEqual({
      completedTurns: 1,
      commandExecutions: 2,
      fileChanges: 2,
      subAgentStarts: 1,
      mcpCalls: 2,
    });
    expect(result.commandStatuses).toEqual({ completed: 1, failed: 1 });
    expect(result.mcpStatuses).toEqual({ completed: 1, failed: 1 });
    expect(result.distinctStartedAgents).toBe(1);
    expect(result.checkpointPrefixSha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    expect(JSON.stringify(result)).not.toContain("agent-a");
  });

  it("binds the exact boundary and ignores later appends, even malformed ones", () => {
    const prefix = jsonl(meta, done(early));
    const suffix = jsonl(
      item("CommandExecution", { status: "failed" }),
      done(late),
    );
    expect(recountBuild(`${prefix}${suffix}`, early)).toEqual(
      recountBuild(prefix, early),
    );
    expect(recountBuild(`${prefix}not-json`, early)).toEqual(
      recountBuild(prefix, early),
    );
    expect(recountBuild(`${prefix}${suffix}`, late).metrics).toMatchObject({
      completedTurns: 2,
      commandExecutions: 1,
    });
  });

  it("refuses an absent completion, invalid timestamp, malformed input and unknown status", () => {
    expect(() =>
      recountBuild(jsonl(meta, event("task_started")), early),
    ).toThrow("boundary");
    expect(() => recountBuild(jsonl(meta, done(early)), late)).toThrow(
      "boundary",
    );
    expect(() => recountBuild("private payload", early)).toThrow(
      "Malformed session JSONL",
    );
    expect(() => recountBuild(jsonl(meta, done(early)), "yesterday")).toThrow(
      "cutoff",
    );
    expect(() =>
      recountBuild(
        jsonl(
          meta,
          item("CommandExecution", { status: "pending" }),
          done(early),
        ),
        early,
      ),
    ).toThrow("status");
  });
});
