import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { eventStamp, monotonicMs } from "./clocks.js";
import type { createCommentary } from "./commentary.js";
import type {
  GameArtifact,
  RoundEnvelope,
  RoundEvent,
  RoundSession,
} from "./contracts.js";
import {
  PublicRoundProjection,
  type PublicRoundState,
} from "./public-state.js";
import { parseViewerSeason, type SeasonTotals } from "./season.js";

export async function startRoundServer(
  options: {
    port?: number;
    overlayDirectory?: string;
    now?: () => number;
    session?: RoundSession;
    season?: SeasonTotals;
    commentary?: ReturnType<typeof createCommentary>;
    publicState?: (state: PublicRoundState) => void;
    record?: (envelope: RoundEnvelope) => void;
    /** Real OBS/browser deaths only; separate from replay and sandbox client evidence. */
    death?: (roundId: string, id: string) => void;
    /** Presentation only. Recorded evidence and sandbox client retain canonical hashes. */
    present?: (event: RoundEvent) => RoundEvent;
    install?: (artifact: GameArtifact, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const now = options.now ?? monotonicMs;
  const clients = new Set<ServerResponse>();
  const artifacts = new Map<string, GameArtifact>();
  const ring: RoundEnvelope[] = [];
  let sequence = 0;
  let origin = "";
  let closing = false;
  let activation = 0;
  let season = options.season ? parseViewerSeason(options.season) : undefined;
  const publicState = new PublicRoundProjection(options.session, season);
  let trigger: RoundEvent["trigger"];
  let input: RoundEvent["input"];
  const send = (client: ServerResponse, envelope: RoundEnvelope) => {
    // Preserve evidence clocks; only the delivery clock changes on reconnect.
    client.write(
      `id: ${envelope.sequence}\nevent: round\ndata: ${JSON.stringify({ ...envelope, event: options.present?.(envelope.event) ?? envelope.event, deliveryAtMs: now() })}\n\n`,
    );
  };
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method === "POST" &&
        request.url === "/api/pit-wall/death" &&
        options.death
      ) {
        if (
          request.headers.origin !== origin ||
          request.headers["content-type"] !== "application/json"
        ) {
          response.writeHead(403).end();
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 512) {
            response.writeHead(413).end();
            return;
          }
        }
        const data: unknown = JSON.parse(body);
        if (
          !data ||
          typeof data !== "object" ||
          !("roundId" in data) ||
          !("id" in data) ||
          typeof data.roundId !== "string" ||
          typeof data.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(data.roundId) ||
          !/^[a-f0-9-]{36}$/.test(data.id)
        ) {
          response.writeHead(400).end();
          return;
        }
        options.death(data.roundId, data.id);
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.headers.origin && request.headers.origin !== origin) {
        const caller = new URL(request.headers.origin);
        if (
          caller.protocol !== "http:" ||
          !["127.0.0.1", "localhost"].includes(caller.hostname)
        ) {
          response.writeHead(403).end();
          return;
        }
        response.setHeader("Access-Control-Allow-Origin", caller.origin);
        response.setHeader("Vary", "Origin");
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/api/public-state") {
        response
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          .end(JSON.stringify(publicState.snapshot()));
        return;
      }
      if (path === "/health") {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end('{"ready":true}');
        return;
      }
      if (path === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        response.flushHeaders();
        response.write(
          `event: session\ndata: ${JSON.stringify(options.session ?? { mode: "local-fixture" })}\n\n`,
        );
        if (season)
          response.write(`event: season\ndata: ${JSON.stringify(season)}\n\n`);
        const after = Number(request.headers["last-event-id"] ?? 0);
        for (const envelope of ring)
          if (envelope.sequence > after) send(response, envelope);
        clients.add(response);
        response.once("close", () => clients.delete(response));
        return;
      }
      const build = /^\/api\/builds\/([a-f0-9]{64})\.js$/.exec(path);
      const commentary = /^\/api\/commentary\/([a-f0-9]{64})\.mp3$/.exec(path);
      if (commentary?.[1]) {
        const bytes = options.commentary?.readAudio(commentary[1]);
        if (!bytes) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          })
          .end(bytes);
        return;
      }
      if (build?.[1]) {
        const artifact = artifacts.get(build[1]);
        if (!artifact) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          })
          .end(artifact.code);
        return;
      }
      if (options.overlayDirectory) {
        const directory = resolve(options.overlayDirectory);
        const file = resolve(
          directory,
          `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`,
        );
        if (!file.startsWith(`${directory}${sep}`)) {
          response.writeHead(403).end();
          return;
        }
        const canonicalDirectory = await realpath(directory);
        const canonicalFile = await realpath(file).catch(() => null);
        if (
          canonicalFile &&
          !canonicalFile.startsWith(`${canonicalDirectory}${sep}`)
        ) {
          response.writeHead(403).end();
          return;
        }
        const info = canonicalFile
          ? await stat(canonicalFile).catch(() => null)
          : null;
        if (info?.isFile()) {
          const contentTypes: Record<string, string> = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".wav": "audio/wav",
          };
          response.writeHead(200, {
            "Content-Type":
              contentTypes[extname(file)] ?? "application/octet-stream",
          });
          createReadStream(canonicalFile as string)
            .on("error", () => response.destroy())
            .pipe(response);
          return;
        }
      }
      response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.destroy();
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Round server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  const publish = (event: RoundEvent) => {
    if (closing) return;
    if (event.type === "round.state" && event.phase === "preparing") {
      trigger = event.trigger;
      input = event.input;
      activation++;
      ring.length = 0;
      artifacts.clear();
    }
    const stamp = { ...eventStamp(), atMs: now() };
    const envelope: RoundEnvelope = {
      sequence: ++sequence,
      ...(input ? { input } : {}),
      ...(trigger ? { trigger } : {}),
      serverTimeMs: stamp.atMs,
      ...stamp,
      event: {
        ...event,
        ...(input ? { input } : {}),
        ...(trigger ? { trigger } : {}),
        atMs: event.atMs ?? stamp.atMs,
        wallTime: event.wallTime ?? stamp.wallTime,
      },
    };
    ring.push(envelope);
    if (ring.length > 2000)
      throw new Error("Round event retention budget exceeded");
    publicState.observe(envelope);
    options.publicState?.(publicState.snapshot(stamp.wallTime));
    options.record?.(envelope);
    for (const client of clients) send(client, envelope);
    // Voice is presentation only and never replayed to reconnecting clients.
    options.commentary?.observe(envelope.event, (commentary) => {
      if (closing) return;
      for (const client of clients)
        client.write(
          `event: commentary\ndata: ${JSON.stringify(commentary)}\n\n`,
        );
    });
  };
  options.publicState?.(publicState.snapshot());
  return {
    origin,
    publish,
    updateSeason(value: SeasonTotals) {
      season = parseViewerSeason(value);
      publicState.updateSeason(season);
      options.publicState?.(publicState.snapshot());
      for (const client of clients)
        client.write(`event: season\ndata: ${JSON.stringify(season)}\n\n`);
    },
    async activate(
      artifact: GameArtifact,
      phase: "broken" | "repaired" | "rollback",
      roundId: string,
      signal: AbortSignal = new AbortController().signal,
    ) {
      artifact = Object.freeze({ ...artifact });
      const revision = ++activation;
      signal.throwIfAborted();
      const digest = createHash("sha256").update(artifact.code).digest("hex");
      if (artifact.digest !== digest || artifact.id !== digest)
        throw new Error("Rejected build identity");
      if (closing) throw new Error("Round server is closed");
      await options.install?.(artifact, signal);
      signal.throwIfAborted();
      if (closing || revision !== activation)
        throw new Error("Stale build activation");
      artifacts.set(artifact.id, artifact);
      publish({
        type: "game.build",
        roundId,
        phase,
        buildId: artifact.id,
        digest,
        ...(artifact.replay
          ? { sourceDigest: artifact.replay.sourceDigest }
          : {}),
      });
    },
    async close() {
      closing = true;
      await options.commentary?.close();
      activation++;
      for (const client of clients) client.end();
      clients.clear();
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      try {
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
      } finally {
        clearTimeout(timer);
      }
      artifacts.clear();
    },
  };
}
