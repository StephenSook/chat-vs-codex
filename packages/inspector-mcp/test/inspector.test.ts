import { describe, expect, it } from "vitest";
import { createState } from "../../sim/src/index.js";
import {
  callTool,
  type InspectorData,
  MAX_WINDOW,
  parseInspectorData,
  TOOLS,
  telemetryFrame,
} from "../src/index.js";
import { lineTransport, MAX_MESSAGE_BYTES, protocol } from "../src/protocol.js";

function fixture(): InspectorData {
  const frame = telemetryFrame(createState(13), null);
  const golden = Array.from({ length: 61 }, (_, index) => ({
    ...structuredClone(frame),
    frame: index,
    input: index === 0 ? null : 2,
  }));
  const buggy = structuredClone(golden);
  if (!buggy[2] || !buggy[3]) throw new Error("Missing test frames");
  buggy[2].player.vy = -128;
  buggy[3].enemy.direction = 1;
  return parseInspectorData({
    schemaVersion: 1,
    fps: 60,
    units: "Q8",
    tracks: [{ name: "replay-01", golden, buggy }],
  });
}
function answer(name: string, args: unknown) {
  const result = callTool(fixture(), name, args);
  return {
    isError: result.isError,
    value: JSON.parse(result.content[0]?.text ?? "null"),
  };
}
describe("read-only recorded Inspector tools", () => {
  it("returns bounded inclusive original-buggy frames and exact differing mechanics", () => {
    const frames = answer("replay_frames", {
      track: "replay-01",
      from: 0,
      to: 2,
    });
    expect(frames.isError).toBe(false);
    expect(frames.value.recording).toBe("original-buggy");
    expect(frames.value.frames).toHaveLength(3);
    expect(frames.value.frames[2].player.vy).toBe(-128);
    expect(
      answer("first_divergence", { track: "replay-01" }).value,
    ).toMatchObject({
      frame: 2,
      fields: { "player.vy": { golden: 0, buggy: -128 } },
    });
    const diff = answer("diff_telemetry", { track: "replay-01", frame: 3 });
    expect(diff.value.fields).toEqual({
      "enemy.direction": { golden: -1, buggy: 1 },
    });
    expect(diff.value.golden.frame).toBe(3);
    expect(diff.value.buggy.frame).toBe(3);
    expect(
      answer("replay_frames", {
        track: "replay-01",
        from: 0,
        to: MAX_WINDOW - 1,
      }).value.frames,
    ).toHaveLength(MAX_WINDOW);
    expect(
      TOOLS.every(
        (tool) =>
          tool.annotations.readOnlyHint &&
          !tool.annotations.openWorldHint &&
          !tool.annotations.destructiveHint,
      ),
    ).toBe(true);
  });
  it("reports no divergence for identical recorded states", () => {
    const data = fixture();
    if (!data.tracks[0]) throw new Error("Missing test track");
    data.tracks[0].buggy = structuredClone(data.tracks[0].golden);
    expect(
      JSON.parse(
        callTool(data, "first_divergence", { track: "replay-01" }).content[0]
          ?.text ?? "null",
      ),
    ).toMatchObject({ frame: null, fields: {} });
  });
  it.each([
    ["replay_frames", { track: "replay-01", from: -1, to: 3 }],
    ["replay_frames", { track: "replay-01", from: 0, to: 30 }],
    ["replay_frames", { track: "replay-01", from: 5, to: 4 }],
    ["replay_frames", { track: "replay-01", from: 50, to: 62 }],
    ["replay_frames", { track: "replay-01", from: "0", to: 1 }],
    ["diff_telemetry", { track: "replay-01", frame: 1.5 }],
    ["diff_telemetry", { track: "replay-01", frame: 61 }],
    ["first_divergence", { track: "replay-01", path: "../../SECRET.txt" }],
    ["first_divergence", { track: "../traces.json" }],
    ["first_divergence", { track: "held-out-delayed-start" }],
    ["first_divergence", null],
    ["eval", { code: "process.env" }],
  ])("refuses %s with malformed or unavailable arguments %j", (name, args) => {
    expect(answer(name as string, args).isError).toBe(true);
  });
  it("never mutates captured telemetry while serving calls", () => {
    const data = fixture();
    const before = JSON.stringify(data);
    for (const tool of TOOLS)
      callTool(
        data,
        tool.name,
        tool.name === "replay_frames"
          ? { track: "replay-01", from: 0, to: 2 }
          : tool.name === "diff_telemetry"
            ? { track: "replay-01", frame: 2 }
            : { track: "replay-01" },
      );
    expect(JSON.stringify(data)).toBe(before);
  });
  it.each(["source", "heldOut", "viewer", "family"])(
    "rejects fixture additions rather than leaking %s",
    (key) => {
      expect(() =>
        parseInspectorData({ ...fixture(), [key]: "private" }),
      ).toThrow();
    },
  );
  it("rejects malformed frame values, inconsistent inputs and duplicate names", () => {
    const data = fixture();
    const track = data.tracks[0];
    if (!track?.buggy[1]) throw new Error("Missing test track");
    expect(() =>
      parseInspectorData({ ...data, tracks: [track, track] }),
    ).toThrow();
    track.buggy[1].input = 7;
    expect(() => parseInspectorData(data)).toThrow("inputs");
    track.buggy[1].input = 2;
    track.buggy[1].player.x = Number.NaN;
    expect(() => parseInspectorData(data)).toThrow();
    track.buggy[1].player.x = 0;
    Object.assign(track.buggy[1].player, { rawSource: "secret" });
    expect(() => parseInspectorData(data)).toThrow();
  });
});

describe("MCP newline JSON-RPC session", () => {
  it("requires initialize and initialized, advertises tools, calls and pings", () => {
    const handle = protocol(fixture());
    const request = (method: string, params?: unknown, id = 1) =>
      handle({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    expect(request("tools/list")).toMatchObject({ error: { code: -32002 } });
    expect(
      request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      }),
    ).toMatchObject({
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
      },
    });
    expect(request("tools/list")).toMatchObject({ error: { code: -32002 } });
    expect(
      handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeUndefined();
    expect(request("tools/list")).toMatchObject({ result: { tools: TOOLS } });
    expect(
      request(
        "tools/call",
        { name: "first_divergence", arguments: { track: "replay-01" } },
        2,
      ),
    ).toMatchObject({ id: 2, result: { isError: false } });
    expect(request("ping")).toMatchObject({ result: {} });
    expect(
      request("resources/read", { uri: "file:///SECRET.txt" }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      request("initialize", { protocolVersion: "2024-11-05" }),
    ).toMatchObject({ error: { code: -32602 } });
  });
  it.each([
    null,
    [],
    "arbitrary",
    1,
    { jsonrpc: "2.0", id: null, method: "ping" },
    { jsonrpc: "2.0", id: {}, method: "ping" },
  ])("refuses malformed JSON-RPC %j", (value) => {
    expect(protocol(fixture())(value)).toMatchObject({
      error: { code: -32600 },
    });
  });
  it("negotiates an unsupported protocol and ignores notifications", () => {
    const handle = protocol(fixture());
    expect(
      handle({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "future" },
      }),
    ).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
    expect(
      handle({ jsonrpc: "2.0", method: "notifications/cancelled" }),
    ).toBeUndefined();
  });
  it("supports fragmented and batched newline transport, with protocol-only output", () => {
    const lines: string[] = [];
    const receive = lineTransport(
      protocol(fixture()),
      (line) => lines.push(line),
      () => {
        throw new Error("Unexpected close");
      },
    );
    receive(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"pi'));
    expect(lines).toEqual([]);
    receive(
      Buffer.from('ng"}\ninvalid\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'),
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Invalid JSON message" },
      },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  });
  it("closes oversized unterminated requests without serving subsequent data", () => {
    const lines: string[] = [];
    let closes = 0;
    const receive = lineTransport(
      protocol(fixture()),
      (line) => lines.push(line),
      () => closes++,
    );
    receive(Buffer.alloc(MAX_MESSAGE_BYTES + 1, 32));
    receive(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));
    expect(closes).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
      error: { message: "Message exceeds the byte budget" },
    });
  });
  it("refuses replies above the output byte budget", () => {
    const lines: string[] = [];
    const receive = lineTransport(
      () => ({ jsonrpc: "2.0", id: 1, result: "x".repeat(65536) }),
      (line) => lines.push(line),
      () => {
        throw new Error("Unexpected close");
      },
    );
    receive(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
      error: { message: "Response exceeds the frame budget" },
    });
  });
});
