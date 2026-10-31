import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type CommentaryAudio,
  commentaryLine,
  createCommentary,
} from "../src/commentary.js";
import type { RoundAutopsy, RoundEvent } from "../src/contracts.js";
import { startRoundServer } from "../src/server.js";

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "commentary-"));
  paths.push(path);
  return path;
}
const roundId = "82589ac9-1b1b-4393-8085-9bed5d88ee2b";
const broken: RoundEvent = {
  type: "game.build",
  roundId,
  phase: "broken",
  buildId: "a".repeat(64),
  digest: "a".repeat(64),
};
const repairing: RoundEvent = {
  type: "round.state",
  roundId,
  phase: "repairing",
  headStartEndsAt: null,
  winner: null,
  reason: null,
};
function fixed(ms: number | null = 16730): RoundEvent {
  const autopsy: RoundAutopsy = {
    roundId,
    status: "verified",
    reason: null,
    breaker: null,
    firstCorrectGuesser: null,
    family: "jump-buffer",
    winner: "codex",
    patch: null,
    explanation: "PRIVATE CHAT TEXT",
    durations: {
      headStartMs: 15000,
      repairMs: null,
      validationMs: null,
      swapMs: null,
      timeToGreenMs: ms,
    },
    previousRoundId: null,
    deltaMs: null,
    regressionTest: null,
    regressionError: null,
  };
  return {
    type: "overlay",
    event: { type: "round.autopsy", roundId, autopsy },
  };
}

it("is silent and performs no synthesis or cache access while disabled", async () => {
  const path = join(await directory(), "absent");
  const synthesize = vi.fn();
  const report = vi.fn();
  const service = createCommentary({
    enabled: false,
    cacheDirectory: path,
    synthesize,
    report,
  });
  service.observe(broken, vi.fn());
  await service.drain();
  await service.close();
  expect(synthesize).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(await stat(path).catch(() => null)).toBeNull();
});

it("uses only fixed phase lines and the measured rounded GREEN duration", () => {
  expect(commentaryLine(broken)?.text).toBe("Something broke.");
  expect(commentaryLine(repairing)?.text).toBe("Codex is in.");
  expect(commentaryLine(fixed())?.text).toBe("Fixed in 17 seconds.");
  expect(commentaryLine(fixed(null))?.text).toBe("Fixed.");
  expect(
    commentaryLine({
      type: "overlay",
      event: { type: "bug.named", roundId, name: "CHAT FREE TEXT" },
    }),
  ).toBeNull();
  const failure = fixed();
  if (failure.type === "overlay" && failure.event.type === "round.autopsy")
    failure.event.autopsy.status = "rolled-back";
  expect(commentaryLine(failure)?.text).toBe("The fix did not land.");
});

it("caches bounded audio privately, deduplicates phases, and only serves registered digests", async () => {
  const cacheDirectory = await directory();
  const synthesize = vi.fn(async () => new Uint8Array([73, 68, 51]));
  const emitted: CommentaryAudio[] = [];
  const service = createCommentary({
    enabled: true,
    cacheDirectory,
    synthesize,
  });
  service.observe(broken, (event) => emitted.push(event));
  await service.drain();
  service.observe(broken, (event) => emitted.push(event));
  await service.drain();
  expect(emitted).toHaveLength(1);
  expect(synthesize).toHaveBeenCalledOnce();
  const filename = (await readdir(cacheDirectory))[0] as string;
  expect((await stat(join(cacheDirectory, filename))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(cacheDirectory, filename))).toEqual(
    Buffer.from([73, 68, 51]),
  );
  expect(service.readAudio(filename.slice(0, -4))).toEqual(
    new Uint8Array([73, 68, 51]),
  );
  expect(service.readAudio("../tokens")).toBeNull();
  expect(service.readAudio("a".repeat(64))).toBeNull();
  await service.close();
  const next = createCommentary({ enabled: true, cacheDirectory, synthesize });
  next.observe(broken, () => {});
  await next.drain();
  await next.close();
  expect(synthesize).toHaveBeenCalledOnce();
});

it("drops obsolete synthesis after phase movement and ignores old round messages", async () => {
  let resolve: (value: Uint8Array) => void = () => {};
  const synthesize = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Uint8Array>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(new Uint8Array([2]));
  const emitted = vi.fn();
  const service = createCommentary({
    enabled: true,
    cacheDirectory: await directory(),
    synthesize,
  });
  service.observe(broken, emitted);
  await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
  service.observe(repairing, emitted);
  service.observe(
    { ...repairing, roundId: "11111111-1111-4111-8111-111111111111" },
    emitted,
  );
  await Promise.resolve();
  resolve(new Uint8Array([1]));
  await service.drain();
  expect(emitted).toHaveBeenCalledOnce();
  expect(emitted.mock.calls[0]?.[0].phase).toBe("repairing");
  service.observe(broken, emitted);
  await service.drain();
  expect(emitted).toHaveBeenCalledOnce();
  await service.close();
});

it("times out noncooperative synthesis without delaying a round or writing late data", async () => {
  const cacheDirectory = await directory();
  const emitted = vi.fn();
  let resolve: (value: Uint8Array) => void = () => {};
  const service = createCommentary({
    enabled: true,
    cacheDirectory,
    timeoutMs: 10,
    synthesize: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  service.observe(broken, emitted);
  await service.drain();
  expect(resolve).not.toBeUndefined();
  resolve(new Uint8Array([1]));
  await Promise.resolve();
  await Promise.resolve();
  expect(emitted).not.toHaveBeenCalled();
  expect(await readdir(cacheDirectory)).toEqual([]);
  await service.close();
});

it("refuses oversized synthesis and reads no cache symlink target", async () => {
  const cacheDirectory = await directory();
  const emitted = vi.fn();
  const service = createCommentary({
    enabled: true,
    cacheDirectory,
    synthesize: async () => new Uint8Array(512 * 1024 + 1),
  });
  service.observe(broken, emitted);
  await service.drain();
  expect(emitted).not.toHaveBeenCalled();
  expect(await readdir(cacheDirectory)).toEqual([]);
  await service.close();
  const seed = createCommentary({
    enabled: true,
    cacheDirectory,
    synthesize: async () => new Uint8Array([1]),
  });
  seed.observe(broken, () => {});
  await seed.drain();
  await seed.close();
  const filename = (await readdir(cacheDirectory))[0] as string;
  await rm(join(cacheDirectory, filename));
  await symlink("/etc/passwd", join(cacheDirectory, filename));
  const synthesize = vi.fn(async () => new Uint8Array([2]));
  const clean = createCommentary({ enabled: true, cacheDirectory, synthesize });
  clean.observe(broken, emitted);
  await clean.drain();
  expect(synthesize).toHaveBeenCalledOnce();
  await clean.close();
});

it("serves session audio only and never replays old commentary on reconnect", async () => {
  const service = createCommentary({
    enabled: true,
    cacheDirectory: await directory(),
    synthesize: async () => new Uint8Array([1, 2, 3]),
  });
  const server = await startRoundServer({ commentary: service });
  try {
    const liveAbort = new AbortController();
    const live = await fetch(`${server.origin}/api/events`, {
      signal: liveAbort.signal,
    });
    const liveReader = live.body?.getReader();
    expect(
      new TextDecoder().decode((await liveReader?.read())?.value),
    ).toContain("event: session");
    server.publish(broken);
    await service.drain();
    let body = "";
    for (let n = 0; n < 3 && !body.includes("event: commentary"); n++)
      body += new TextDecoder().decode((await liveReader?.read())?.value);
    expect(body).toContain("event: commentary");
    const url = /\/api\/commentary\/[a-f0-9]{64}\.mp3/.exec(body)?.[0];
    expect(url).toBeTruthy();
    liveAbort.abort();
    await liveReader?.cancel().catch(() => {});
    const response = await fetch(`${server.origin}${url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (await fetch(`${server.origin}/api/commentary/${"a".repeat(64)}.mp3`))
        .status,
    ).toBe(404);
    const connection = new AbortController();
    const sse = await fetch(`${server.origin}/api/events`, {
      signal: connection.signal,
    });
    const reader = sse.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).not.toContain(
      "event: commentary",
    );
    connection.abort();
    await reader?.cancel().catch(() => {});
  } finally {
    await server.close();
  }
});
