import { callTool, type InspectorData, TOOLS } from "./index.js";

export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
const protocols = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** One session per stdio connection. Notifications never receive replies. */
export function protocol(data: InspectorData): (value: unknown) => unknown {
  let initialized = false;
  let ready = false;
  return (value) => {
    const request = value as Record<string, unknown> | null;
    const validId =
      typeof request?.id === "string" ||
      (typeof request?.id === "number" && Number.isSafeInteger(request.id));
    const id = validId ? request?.id : null;
    const error = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string" ||
      ("id" in request && !validId)
    )
      return error(-32600, "Invalid request");
    if (!("id" in request)) {
      if (request.method === "notifications/initialized" && initialized)
        ready = true;
      return undefined;
    }
    const response = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const params = request.params as Record<string, unknown> | undefined;
    if (request.method === "initialize") {
      if (initialized || !params || typeof params.protocolVersion !== "string")
        return error(-32602, "Invalid initialization");
      initialized = true;
      return response({
        protocolVersion: protocols.includes(params.protocolVersion)
          ? params.protocolVersion
          : protocols[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "game-inspector", version: "1.0.0" },
        instructions: `Read-only original-buggy visible replay telemetry. Tracks: ${data.tracks.map((track) => track.name).join(", ")}. Coordinates use Q8 fixed point (256 units per pixel). No held-out data or source is exposed.`,
      });
    }
    if (request.method === "ping") return response({});
    if (!ready) return error(-32002, "Initialize the connection first");
    if (request.method === "tools/list") return response({ tools: TOOLS });
    if (request.method === "tools/call")
      return response(callTool(data, params?.name, params?.arguments));
    return error(-32601, "Unknown method");
  };
}

/** Process complete newline messages with a bounded tail, without an unbounded readline buffer. */
export function lineTransport(
  handle: (value: unknown) => unknown,
  send: (line: string) => void,
  close: () => void,
): (bytes: Buffer) => void {
  let pending = Buffer.alloc(0);
  let closed = false;
  const reply = (value: unknown) => {
    if (value === undefined) return;
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
      send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Response exceeds the frame budget" },
        }),
      );
      return;
    }
    send(encoded);
  };
  return (bytes) => {
    if (closed) return;
    pending = Buffer.concat([pending, bytes]);
    for (
      let newline = pending.indexOf(10);
      newline >= 0;
      newline = pending.indexOf(10)
    ) {
      if (newline > MAX_MESSAGE_BYTES) break;
      const line = pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        reply(handle(JSON.parse(line)));
      } catch {
        reply({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON message" },
        });
      }
    }
    if (pending.length > MAX_MESSAGE_BYTES) {
      closed = true;
      reply({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Message exceeds the byte budget" },
      });
      close();
    }
  };
}
