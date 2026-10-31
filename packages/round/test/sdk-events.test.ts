import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";
import { parseRoundEnvelope } from "../../../apps/overlay/src/bridge.js";
import { stepLabel } from "../../../apps/overlay/src/events.js";
import { sdkOverlayEvent } from "../src/sdk-events.js";

it("accepts the observed SDK null exit code as running, reserving green for the trusted validator", () => {
  // The committed real benchmark events contain null at item.started, although
  // SDK0.163's declared type describes the field as an optional number.
  const item = {
    id: "observed-tests",
    type: "command_execution",
    command: '/bin/zsh -lc "node node_modules/vitest/vitest.mjs run"',
    aggregated_output: "",
    status: "in_progress",
    exit_code: null,
  };
  expect(
    sdkOverlayEvent("round", {
      type: "item.started",
      item,
    } as unknown as ThreadEvent),
  ).toMatchObject({ status: "running", step: { kind: "tests" } });
  expect(
    sdkOverlayEvent("round", {
      type: "item.completed",
      item: { ...item, status: "completed", exit_code: 0 },
    } as unknown as ThreadEvent),
  ).toMatchObject({ status: "done", step: { kind: "tests" } });
  expect(
    sdkOverlayEvent("round", {
      type: "item.completed",
      item: { ...item, status: "failed", exit_code: 1 },
    } as unknown as ThreadEvent),
  ).toMatchObject({ status: "failed" });
});

const command = (
  value: string,
  status: "in_progress" | "completed" | "failed" = "completed",
  exit_code = 0,
) =>
  sdkOverlayEvent("round", {
    type: "item.completed",
    item: {
      id: "cmd",
      type: "command_execution",
      command: value,
      status,
      exit_code,
      aggregated_output: "private output stays private",
    },
  });

describe("observed SDK command categories", () => {
  it.each([
    [
      'pwd && rg --files -g "!node_modules"',
      { kind: "activity", action: "discover" },
    ],
    [
      "/bin/zsh -lc 'cat src/world.ts src/index.ts package.json'",
      { kind: "reading", path: "world.ts" },
    ],
    [
      '/bin/bash -c "head -40 src/index.ts"',
      { kind: "reading", path: "index.ts" },
    ],
    ["node node_modules/vitest/vitest.mjs run", { kind: "tests" }],
    ["pnpm run test", { kind: "tests" }],
    ["pnpm exec vitest run", { kind: "tests" }],
    ["pnpm replay:all", { kind: "replay" }],
    ["apply_patch < patch.txt", { kind: "activity", action: "edit" }],
    ["git diff --stat", { kind: "activity", action: "command" }],
  ])("keeps %s visible with a safe category", (raw, step) => {
    expect(command(raw)).toMatchObject({ step, status: "done" });
  });

  it("recognizes the real observed shell-quoted Python patch plus Vitest command", () => {
    const script =
      "python3 -c \"from pathlib import Path; p=Path('src/index.ts'); s=p.read_text(); s=s.replace('if (state.grounded) return vy - GRAVITY;', 'if (state.grounded) return vy + GRAVITY;'); p.write_text(s)\" && node node_modules/vitest/vitest.mjs run";
    const wrapped = `/bin/zsh -lc "${script.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const result = command(wrapped);
    expect(result).toMatchObject({
      step: { kind: "activity", action: "edit-test" },
      status: "done",
    });
    expect(JSON.stringify(result)).not.toContain("GRAVITY");
    expect(JSON.stringify(result)).not.toContain("private output");
  });

  it.each([
    'echo "secret-token vitest && node node_modules/vitest/vitest.mjs run"',
    'printf "%s" "vitest run"',
    "vitest run | cat",
    "vitest run || true",
    "vitest run; echo done",
    "vitest --help",
    "node node_modules/vitest/vitest.mjs list",
    "pnpm test --help",
  ])("does not claim test success from %s", (raw) => {
    const result = command(raw);
    expect(result).toMatchObject({
      step: { kind: "activity", action: "command" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("preserves failures even when the SDK status field says completed", () => {
    expect(command("vitest run", "completed", 1)).toMatchObject({
      status: "failed",
    });
    expect(command("cat src/index.ts", "failed", 0)).toMatchObject({
      status: "failed",
    });
  });
});

describe("all observed SDK item types", () => {
  const items: { item: ThreadItem; action: string; status?: string }[] = [
    {
      item: {
        id: "patch",
        type: "file_change",
        status: "completed",
        changes: [{ path: "secret/path/index.ts", kind: "update" }],
      },
      action: "edit",
    },
    {
      item: { id: "response", type: "agent_message", text: "private response" },
      action: "respond",
    },
    {
      item: { id: "reason", type: "reasoning", text: "private reasoning" },
      action: "reason",
    },
    {
      item: { id: "search", type: "web_search", query: "private query" },
      action: "search",
    },
    {
      item: {
        id: "plan",
        type: "todo_list",
        items: [{ text: "private task", completed: false }],
      },
      action: "plan",
    },
    {
      item: { id: "error", type: "error", message: "private error" },
      action: "error",
      status: "failed",
    },
  ];
  it.each(items)(
    "labels $item.type without exposing private text or invented counts",
    ({ item, action, status }) => {
      const result = sdkOverlayEvent("round", { type: "item.completed", item });
      expect(result).toMatchObject({
        id: item.id,
        step: { kind: "activity", action },
        status: status ?? "done",
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("added");
    },
  );
  it("shows observed incremental items as running and tool errors as failed", () => {
    expect(
      sdkOverlayEvent("round", {
        type: "item.updated",
        item: { id: "r", type: "reasoning", text: "private" },
      }),
    ).toMatchObject({ status: "running" });
    expect(
      sdkOverlayEvent("round", {
        type: "item.completed",
        item: {
          id: "t",
          type: "mcp_tool_call",
          server: "server",
          tool: "tool",
          arguments: {},
          status: "completed",
          error: { message: "private" },
        },
      }),
    ).toMatchObject({ status: "failed" });
    expect(sdkOverlayEvent("round", { type: "turn.started" })).toBeNull();
  });
});

it("names real Inspector requests and bounded argument summaries without exposing other arguments or results", () => {
  const item: ThreadItem = {
    id: "inspector",
    type: "mcp_tool_call",
    server: "game_inspector",
    tool: "diff_telemetry",
    arguments: { track: "replay-00", frame: 212, secret: "must-stay-private" },
    status: "in_progress",
  };
  const observed = sdkOverlayEvent("round", { type: "item.started", item });
  expect(observed).toMatchObject({
    status: "running",
    step: { kind: "tool", name: "Inspector", summary: "replay frame 212" },
  });
  expect(JSON.stringify(observed)).not.toContain("must-stay-private");
  const range = {
    ...item,
    tool: "replay_frames",
    arguments: { from: 200, to: 212 },
  };
  expect(
    sdkOverlayEvent("round", { type: "item.completed", item: range }),
  ).toMatchObject({ step: { summary: "replay 200-212" } });
  expect(
    sdkOverlayEvent("round", {
      type: "item.completed",
      item: { ...item, tool: "first_divergence" },
    }),
  ).toMatchObject({ step: { summary: "first divergence" } });
});
it("names SDK file tools with basenames and refuses to echo arbitrary tool arguments", () => {
  const item: ThreadItem = {
    id: "read",
    type: "mcp_tool_call",
    server: "tools",
    tool: "read_file",
    arguments: { file_path: "/secret/path/physics.ts" },
    status: "completed",
  };
  expect(sdkOverlayEvent("r", { type: "item.completed", item })).toMatchObject({
    step: { kind: "reading", path: "physics.ts" },
  });
  const unknown = sdkOverlayEvent("r", {
    type: "item.completed",
    item: {
      ...item,
      tool: "inspect",
      arguments: { token: "private-token", text: "private-text" },
    },
  });
  expect(unknown).toMatchObject({ step: { kind: "tool", name: "inspect" } });
  expect(JSON.stringify(unknown)).not.toContain("private");
  expect(
    sdkOverlayEvent("r", {
      type: "item.completed",
      item: {
        ...item,
        tool: "unsafe\nidentifier",
        error: { message: "private-error" },
      },
    }),
  ).toMatchObject({ status: "failed", step: { name: "MCP" } });
});

it("carries the observed tool step through the real wire guard and ticker formatter", () => {
  const event = sdkOverlayEvent("r", {
    type: "item.started",
    item: {
      id: "frame",
      type: "mcp_tool_call",
      server: "game_inspector",
      tool: "diff_telemetry",
      arguments: { frame: 212 },
      status: "in_progress",
    },
  });
  if (!event || event.type !== "codex.step")
    throw new Error("Missing observed tool event");
  expect(stepLabel(event.step)).toBe("Inspector: replay frame 212");
  expect(
    parseRoundEnvelope({
      sequence: 1,
      serverTimeMs: 1,
      event: { type: "overlay", event },
    }),
  ).toMatchObject({ event: { event } });
  expect(() =>
    parseRoundEnvelope({
      sequence: 1,
      serverTimeMs: 1,
      event: {
        type: "overlay",
        event: {
          ...event,
          step: { kind: "tool", name: "MCP", summary: "unsafe\nargument" },
        },
      },
    }),
  ).toThrow();
});
