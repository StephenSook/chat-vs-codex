import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { stepLabel } from "../../../apps/overlay/src/events.js";
import {
  type Action,
  initialState,
  parseClientFrame,
  type ServerFrame,
  type State,
} from "../../pit-wall/src/protocol.js";
import { monotonicMs } from "./clocks.js";
import type { RoundEnvelope } from "./contracts.js";

export const PIT_WALL_PORT = 4318;
export function projectPitWall(state: State, envelope: RoundEnvelope): State {
  const e = envelope.event;
  if (e.type === "round.state") {
    if (e.phase === "preparing")
      return {
        ...initialState(),
        chat: state.chat,
        codex: state.codex,
        roundId: e.roundId,
        phase: e.phase,
      };
    if (e.roundId !== state.roundId) return state;
    return {
      ...state,
      phase: e.phase,
      headStartEndsAt: e.headStartEndsAt,
      ...(e.phase === "rolled-back"
        ? { bug: "none" as const, headline: e.reason ?? "Round rolled back" }
        : {}),
    };
  }
  if (e.type !== "overlay") return state;
  const event = e.event;
  if ("roundId" in event && event.roundId !== state.roundId) return state;
  switch (event.type) {
    case "round.started":
      return {
        ...state,
        roundId: event.id,
        number: event.number,
        bug: "none",
        deaths: 0,
        step: null,
        headline: null,
      };
    case "score.changed":
      return { ...state, chat: event.chat, codex: event.codex };
    case "simulation.death":
      return { ...state, deaths: state.deaths + 1 };
    case "bug.active":
      return { ...state, bug: "active" };
    case "bug.named":
      return { ...state, bugName: event.name };
    case "tests.green":
      return { ...state, bug: "fixed" };
    case "codex.step":
      return {
        ...state,
        step: `${event.model ? `${event.model.toUpperCase()}: ` : ""}${stepLabel(event.step)}${event.status === "failed" ? " (failed)" : ""}`.slice(
          0,
          240,
        ),
      };
    case "round.autopsy":
      return {
        ...state,
        headline: (
          event.autopsy.headline ??
          event.autopsy.explanation ??
          "Round complete"
        ).slice(0, 240),
      };
    default:
      return state;
  }
}

/** Separate opt-in listener. Tokens expire with the runner and never enter URLs/logs. */
export async function startPitWall(options: {
  port?: number;
  now?: () => number;
  action(action: Action): { accepted: boolean; reason: string };
  record(entry: Record<string, unknown>): void;
  announce(message: string): void;
}) {
  const port = options.port ?? PIT_WALL_PORT;
  if (port === 4317) throw new Error("Pit Wall must never listen on port 4317");
  const now = options.now ?? monotonicMs;
  const code = String(randomInt(100000, 1000000));
  const expires = now() + 300_000;
  let attempts = 0;
  let state = initialState();
  let sequence = 0;
  const deaths = new Set<string>();
  const tokens = new Set<string>();
  const sessions = new Map<WebSocket, string>();
  const seen = new Map<
    string,
    Map<
      string,
      { fingerprint: string; reply: Extract<ServerFrame, { type: "ack" }> }
    >
  >();
  const send = (socket: WebSocket, frame: ServerFrame) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 128_000) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const snapshot = () => ({
    type: "state" as const,
    sequence: ++sequence,
    serverTimeMs: now(),
    state,
  });
  const server = createServer((_req, res) => res.writeHead(404).end());
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/" ||
      (req.headers.origin && req.headers.origin !== "pit-wall-native") ||
      ws.clients.size >= 8
    ) {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) =>
      ws.emit("connection", client, req),
    );
  });
  ws.on("connection", (socket) => {
    const timeout = setTimeout(() => socket.close(1008, "Authenticate"), 5000);
    let messages = 0;
    let windowAt = now();
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timeout);
      sessions.delete(socket);
    });
    socket.on("message", (bytes, binary) => {
      if (now() - windowAt > 10_000) {
        windowAt = now();
        messages = 0;
      }
      if (++messages > 30) {
        socket.close(1008, "Rate limit");
        return;
      }
      let input: unknown;
      try {
        input = binary ? null : JSON.parse(bytes.toString());
      } catch {
        input = null;
      }
      const frame = parseClientFrame(input);
      if (!frame) {
        send(socket, { type: "error", reason: "invalid-frame" });
        return;
      }
      if (frame.type === "pair") {
        if (
          sessions.has(socket) ||
          tokens.size >= 4 ||
          now() >= expires ||
          ++attempts > 20 ||
          !timingSafeEqual(Buffer.from(frame.code), Buffer.from(code))
        ) {
          send(socket, { type: "error", reason: "pairing-refused" });
          socket.close(1008);
          return;
        }
        const token = randomBytes(32).toString("hex");
        tokens.add(token);
        seen.set(token, new Map());
        sessions.set(socket, token);
        clearTimeout(timeout);
        options.record({ type: "pit-wall.paired" });
        send(socket, { type: "paired", token });
        send(socket, snapshot());
        return;
      }
      if (frame.type === "auth") {
        const token = [...tokens].find((t) =>
          timingSafeEqual(Buffer.from(t), Buffer.from(frame.token)),
        );
        if (!token) {
          send(socket, { type: "error", reason: "unauthorized" });
          socket.close(1008);
          return;
        }
        sessions.set(socket, token);
        clearTimeout(timeout);
        send(socket, snapshot());
        return;
      }
      const token = sessions.get(socket);
      if (!token) {
        options.record({
          type: "pit-wall.action",
          id: frame.id,
          roundId: frame.roundId,
          action: frame.action,
          accepted: false,
          reason: "unauthorized",
        });
        send(socket, { type: "error", reason: "unauthorized" });
        socket.close(1008);
        return;
      }
      const cache = seen.get(token);
      const fingerprint = JSON.stringify(frame);
      const prior = cache?.get(frame.id);
      if (prior) {
        send(
          socket,
          prior.fingerprint === fingerprint
            ? prior.reply
            : {
                type: "ack",
                id: frame.id,
                accepted: false,
                reason: "id-reused",
              },
        );
        return;
      }
      let result: { accepted: boolean; reason: string };
      try {
        result = options.action(frame);
      } catch {
        result = { accepted: false, reason: "action-failed" };
      }
      const reply = { type: "ack" as const, id: frame.id, ...result };
      cache?.set(frame.id, { fingerprint, reply });
      if ((cache?.size ?? 0) > 256)
        cache?.delete(cache.keys().next().value ?? "");
      options.record({
        type: "pit-wall.action",
        id: frame.id,
        roundId: frame.roundId,
        action: frame.action,
        ...(frame.action === "hint" ? { family: frame.family } : {}),
        ...result,
      });
      send(socket, reply);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Pit Wall has no TCP address");
  const heartbeat = setInterval(() => {
    const frame = snapshot();
    for (const socket of sessions.keys()) send(socket, frame);
  }, 15_000);
  heartbeat.unref();
  const hosts = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a?.family === "IPv4" && !a.internal)
    .map((a) => `ws://${a?.address}:${address.port}`);
  options.announce(
    `Pit Wall: ${hosts.join(" or ") || `ws://<Mac LAN IP>:${address.port}`} | Pairing code: ${code} (5 min; restart runner to renew). Trusted LAN only.`,
  );
  return {
    port: address.port,
    publish(envelope: RoundEnvelope) {
      if (
        envelope.event.type === "round.state" &&
        envelope.event.phase === "preparing"
      )
        deaths.clear();
      const next = projectPitWall(state, envelope);
      if (next === state) return;
      state = next;
      const frame = snapshot();
      for (const socket of sessions.keys()) send(socket, frame);
    },
    death(roundId: string, id: string) {
      if (
        state.roundId !== roundId ||
        !["head-start", "repairing", "validating", "swapping"].includes(
          state.phase,
        ) ||
        deaths.has(id) ||
        deaths.size >= 2000
      )
        return;
      deaths.add(id);
      state = { ...state, deaths: state.deaths + 1 };
      const frame = snapshot();
      for (const socket of sessions.keys()) send(socket, frame);
    },
    async close() {
      clearInterval(heartbeat);
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      tokens.clear();
      sessions.clear();
      seen.clear();
    },
  };
}
