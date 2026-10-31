import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  headStartSeconds,
  initialBroadcast,
  reduceBroadcast,
} from "../../../apps/overlay/src/events.js";
import type {
  GameArtifact,
  RoundEnvelope,
  RoundEvent,
} from "../src/contracts.js";
import { startRoundServer } from "../src/server.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(options: Parameters<typeof startRoundServer>[0] = {}) {
  const running = await startRoundServer(options);
  cleanups.push(() => running.close());
  return running;
}

function artifact(code = "export const marker = 1;"): GameArtifact {
  const digest = createHash("sha256").update(code).digest("hex");
  return { id: digest, digest, code };
}

const preparing = (roundId: string): RoundEvent => ({
  type: "round.state",
  phase: "preparing",
  roundId,
  headStartEndsAt: null,
  winner: null,
  reason: null,
});

async function http(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<{
    status: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>((resolve, reject) => {
    const req = request(
      `${origin}${path}`,
      { method: options.method ?? "GET", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
        response.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(2000, () =>
      req.destroy(new Error("HTTP test request timed out")),
    );
    req.end();
  });
}

async function sse(origin: string, after?: number) {
  return new Promise<{
    next(): Promise<RoundEnvelope>;
    end: Promise<void>;
    close(): void;
  }>((resolve, reject) => {
    const req = request(`${origin}/api/events`, {
      headers: after === undefined ? {} : { "Last-Event-ID": String(after) },
    });
    req.on("error", reject);
    req.on("response", (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`SSE status ${response.statusCode}`));
        return;
      }
      const queue: RoundEnvelope[] = [];
      const waiting: {
        resolve(value: RoundEnvelope): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }[] = [];
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", (data: string) => {
        buffer += data;
        for (
          let boundary = buffer.indexOf("\n\n");
          boundary >= 0;
          boundary = buffer.indexOf("\n\n")
        ) {
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = message
            .split("\n")
            .find((value) => value.startsWith("data: "));
          if (!line) continue;
          const envelope = JSON.parse(line.slice(6)) as RoundEnvelope;
          const pending = waiting.shift();
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(envelope);
          } else queue.push(envelope);
        }
      });
      const end = new Promise<void>((done) => response.once("end", done));
      const close = () => {
        req.destroy();
        for (const pending of waiting.splice(0)) {
          clearTimeout(pending.timer);
          pending.reject(new Error("SSE test client closed"));
        }
      };
      cleanups.push(close);
      resolve({
        end,
        close,
        next() {
          const available = queue.shift();
          if (available) return Promise.resolve(available);
          return new Promise<RoundEnvelope>((done, failed) => {
            const item = {
              resolve: done,
              reject: failed,
              timer: setTimeout(() => {
                const index = waiting.indexOf(item);
                if (index >= 0) waiting.splice(index, 1);
                failed(new Error("SSE test event timed out"));
              }, 2000),
            };
            waiting.push(item);
          });
        },
      });
    });
    req.end();
  });
}

describe("local round HTTP and SSE boundary", () => {
  it("binds the verified bytes before an asynchronous install can mutate caller-owned data", async () => {
    let release!: () => void;
    const records: RoundEnvelope[] = [];
    const running = await server({
      record: (entry) => records.push(entry),
      install: async () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
    const build = artifact("export const marker = 'verified';");
    const verified = { ...build };
    const pending = running.activate(build, "broken", "r");
    build.code = "export const marker = 'changed during install';";
    build.id = "f".repeat(64);
    release();
    await pending;
    const served = await http(running.origin, `/api/builds/${verified.id}.js`);
    expect(served.status).toBe(200);
    expect(served.body).toBe(verified.code);
    expect(records[0]?.event).toMatchObject({
      type: "game.build",
      buildId: verified.id,
      digest: verified.digest,
    });
  });
  it("records the original journal, validates before publishing, and serves the exact immutable artifact", async () => {
    const records: RoundEnvelope[] = [];
    const installed: GameArtifact[] = [];
    const running = await server({
      now: () => 10,
      record: (event) => records.push(event),
      install: async (build) => {
        installed.push(build);
      },
    });
    const stream = await sse(running.origin);
    const build = artifact();
    await running.activate(build, "broken", "r");
    const delivered = await stream.next();
    expect(installed).toEqual([build]);
    expect(records).toHaveLength(1);
    const { deliveryAtMs, ...original } = delivered;
    expect(original).toEqual(records[0]);
    expect(deliveryAtMs).toBe(10);
    expect(delivered.atMs).toBe(10);
    expect(delivered.event.atMs).toBe(10);
    expect(delivered.wallTime).toBe(delivered.event.wallTime);
    expect(delivered.event).toMatchObject({
      type: "game.build",
      roundId: "r",
      buildId: build.digest,
      digest: build.digest,
    });
    const served = await http(running.origin, `/api/builds/${build.id}.js`);
    expect(served.status).toBe(200);
    expect(served.body).toBe(build.code);
    expect(served.headers["content-type"]).toContain("text/javascript");
    expect(served.headers["cache-control"]).toContain("immutable");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    build.code = "tampered caller object";
    expect(
      (await http(running.origin, `/api/builds/${build.id}.js`)).body,
    ).toBe(served.body);
  });

  it("never installs, publishes, or serves a mismatched digest", async () => {
    const records: RoundEnvelope[] = [];
    let installs = 0;
    const running = await server({
      record: (event) => records.push(event),
      install: async () => {
        installs++;
      },
    });
    const bad = { ...artifact(), digest: "a".repeat(64), id: "a".repeat(64) };
    await expect(running.activate(bad, "broken", "r")).rejects.toThrow(
      "Rejected build identity",
    );
    expect(installs).toBe(0);
    expect(records).toEqual([]);
    expect(
      (await http(running.origin, `/api/builds/${bad.id}.js`)).status,
    ).toBe(404);
  });

  it("replays with the delivery clock without rewriting recorded evidence or restarting countdowns", async () => {
    let now = 10000;
    const records: RoundEnvelope[] = [];
    const running = await server({
      now: () => now,
      record: (event) => records.push(event),
    });
    running.publish({
      type: "overlay",
      event: { type: "round.started", id: "r", number: 1, atMs: now },
    });
    now = 14000;
    const stream = await sse(running.origin);
    const delivered = await stream.next();
    expect(delivered.serverTimeMs).toBe(10000);
    expect(delivered.atMs).toBe(10000);
    expect(delivered.deliveryAtMs).toBe(14000);
    expect(records[0]?.serverTimeMs).toBe(10000);
    if (
      delivered.event.type !== "overlay" ||
      delivered.event.event.type !== "round.started"
    )
      throw new Error("Expected replayed start");
    const event = delivered.event.event;
    const state = reduceBroadcast(initialBroadcast(), {
      ...event,
      atMs:
        5000 + event.atMs - (delivered.deliveryAtMs ?? delivered.serverTimeMs),
    });
    expect(headStartSeconds(state, 5000)).toBe(11);
  });

  it("resumes only messages after Last-Event-ID and retires the old round replay", async () => {
    const running = await server();
    running.publish(preparing("first"));
    running.publish({
      type: "overlay",
      event: {
        type: "round.started",
        id: "first",
        number: 1,
        atMs: Date.now(),
      },
    });
    running.publish({
      type: "overlay",
      event: { type: "bug.active", roundId: "first", intensity: 0.7 },
    });
    const resumed = await sse(running.origin, 2);
    expect((await resumed.next()).sequence).toBe(3);
    resumed.close();
    running.publish(preparing("next"));
    const fresh = await sse(running.origin);
    const replay = await fresh.next();
    expect(replay.sequence).toBe(4);
    expect(replay.event).toMatchObject({
      type: "round.state",
      roundId: "next",
    });
  });

  it("does not publish a stale install after a newer rollback activation completes", async () => {
    let release!: () => void;
    const slow = artifact("export const marker = 'slow';");
    const rollback = artifact("export const marker = 'rollback';");
    const records: RoundEnvelope[] = [];
    const running = await server({
      record: (event) => records.push(event),
      install: async (build) => {
        if (build.id === slow.id)
          await new Promise<void>((done) => {
            release = done;
          });
      },
    });
    const pending = running.activate(slow, "broken", "r").then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await running.activate(rollback, "rollback", "r");
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(records.map((entry) => entry.event)).toEqual([
      expect.objectContaining({
        type: "game.build",
        roundId: "r",
        phase: "rollback",
        buildId: rollback.id,
        digest: rollback.digest,
      }),
    ]);
    expect(
      (await http(running.origin, `/api/builds/${slow.id}.js`)).status,
    ).toBe(404);
  });

  it("does not publish an install callback that returns after its signal was aborted", async () => {
    let release!: () => void;
    const records: RoundEnvelope[] = [];
    const running = await server({
      record: (event) => records.push(event),
      install: async () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
    const controller = new AbortController();
    const build = artifact();
    const pending = running
      .activate(build, "broken", "r", controller.signal)
      .then(
        () => "unexpected success",
        (error: unknown) => error,
      );
    controller.abort();
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(records).toEqual([]);
    expect(
      (await http(running.origin, `/api/builds/${build.id}.js`)).status,
    ).toBe(404);
  });

  it("invalidates a pending install when a new round starts preparing", async () => {
    let release!: () => void;
    const records: RoundEnvelope[] = [];
    const running = await server({
      record: (event) => records.push(event),
      install: async () =>
        new Promise<void>((done) => {
          release = done;
        }),
    });
    running.publish(preparing("old"));
    const build = artifact();
    const pending = running.activate(build, "broken", "old").then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    running.publish(preparing("new"));
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(
      records.filter((entry) => entry.event.type === "game.build"),
    ).toEqual([]);
  });

  it("refuses untrusted origins, POSTs, traversal, and outside files reached through symlinks", async () => {
    const parent = await mkdtemp(join(tmpdir(), "round-http-test-"));
    cleanups.push(() => rm(parent, { recursive: true, force: true }));
    const overlay = join(parent, "overlay");
    await mkdir(overlay);
    await writeFile(
      join(overlay, "index.html"),
      "<title>Local overlay</title>",
    );
    await writeFile(join(parent, "SECRET.txt"), "local test canary only");
    await symlink(join(parent, "SECRET.txt"), join(overlay, "escaped.txt"));
    const running = await server({ overlayDirectory: overlay });
    expect((await http(running.origin, "/")).body).toContain("Local overlay");
    expect(
      (
        await http(running.origin, "/health", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await http(running.origin, "/health", { method: "POST" })).status,
    ).toBe(405);
    for (const path of ["/%2e%2e%2fSECRET.txt", "/escaped.txt", "/%GG"]) {
      const response = await http(running.origin, path);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("local test canary only");
    }
    const local = await http(running.origin, "/health", {
      headers: { Origin: "http://localhost:4173" },
    });
    expect(local.status).toBe(200);
    expect(local.headers["access-control-allow-origin"]).toBe(
      "http://localhost:4173",
    );
  });

  it("ends SSE responses and refuses new activation after shutdown", async () => {
    const running = await startRoundServer();
    const stream = await sse(running.origin);
    await running.close();
    await stream.end;
    await expect(running.activate(artifact(), "broken", "r")).rejects.toThrow(
      "closed",
    );
  });
});
