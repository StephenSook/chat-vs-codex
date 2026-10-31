import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialBroadcast } from "../../../apps/overlay/src/events.js";
import type { ClientSnapshot } from "../src/client.js";
import type { RoundEnvelope } from "../src/contracts.js";
import type { RoundSnapshot } from "../src/engine.js";
import {
  loadPreviousVerifiedRound,
  publicReceipt,
  saveReceipt,
  viewerKey,
  viewerLabel,
} from "../src/receipt.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "receipt-test-"));
  directories.push(path);
  return path;
}
function verified() {
  const result: RoundSnapshot = {
    type: "round.state",
    roundId: "65e06ea8-d2bd-4e40-9ec7-79f4318c2b02",
    phase: "resolved",
    headStartEndsAt: 15000,
    winner: "codex",
    reason: null,
    scores: { chat: 0, codex: 1 },
    guessClosesAt: 60000,
    active: false,
    durations: {
      headStartMs: 15000,
      repairMs: 9000,
      validationMs: 2000,
      swapMs: 3,
      timeToGreenMs: 11003,
    },
  };
  const client: ClientSnapshot = {
    frame: 1800,
    hash: "0d367b3a",
    alive: true,
    won: false,
    buildId: "a".repeat(64),
    sdkSteps: 5,
    installs: [
      { buildId: "b".repeat(64), frame: 40, statePreserved: true },
      { buildId: "a".repeat(64), frame: 1790, statePreserved: true },
    ],
    broadcast: { ...initialBroadcast(), bug: "fixed", bugName: "gravity-sign" },
  };
  return {
    result,
    client,
    breaker: viewerLabel("private-name", Buffer.alloc(32, 1)),
    events: [],
  };
}
it("publishes only whitelisted evidence, preserving actual monotonic and ISO stamps", () => {
  const input = verified();
  const receipt = publicReceipt({
    ...input,
    events: [
      {
        sequence: 1,
        serverTimeMs: 1234,
        atMs: 99,
        wallTime: "2026-10-31T00:00:00.000Z",
        event: { ...input.result, reason: "private-name token=secret" },
      },
    ],
  });
  expect(receipt.durations?.timeToGreenMs).toBe(11003);
  expect(receipt.events[0]).toEqual({
    sequence: 1,
    type: "round.state",
    phase: "resolved",
    atMs: 99,
    wallTime: "2026-10-31T00:00:00.000Z",
  });
  expect(JSON.stringify(receipt)).not.toMatch(/private-name|token=|secret/);
});

it("labels live Twitch receipts without inventing a fixture", () => {
  const receipt = publicReceipt({ ...verified(), mode: "live-twitch" });
  expect(receipt.mode).toBe("live-twitch");
  expect(receipt).not.toHaveProperty("fixture");
});
it("refuses failed gates, failed swaps and raw viewer identities", () => {
  const input = verified();
  expect(() =>
    publicReceipt({
      ...input,
      result: { ...input.result, phase: "rolled-back" },
    }),
  ).toThrow(/verified/);
  expect(() =>
    publicReceipt({
      ...input,
      client: {
        ...input.client,
        installs: [
          { buildId: "a".repeat(64), frame: 1, statePreserved: false },
        ],
      },
    }),
  ).toThrow(/verified/);
  expect(() => publicReceipt({ ...input, breaker: "private-name" })).toThrow(
    /verified/,
  );
});
it("binds public validation trace hashes to the installed repaired source, without publishing frames", () => {
  const input = verified();
  const replay = {
    fps: 60 as const,
    sourceDigest: "a".repeat(64),
    trackDigest: "b".repeat(64),
    frames: [
      {
        frame: 1,
        x: 123,
        y: 456,
        alive: true,
        won: false,
        stateHash: "aabbccdd",
      },
    ],
  };
  const events: RoundEnvelope[] = [
    {
      sequence: 1,
      serverTimeMs: 1,
      event: {
        type: "overlay",
        event: {
          type: "round.ghost",
          roundId: input.result.roundId ?? "",
          replay,
        },
      },
    },
    {
      sequence: 2,
      serverTimeMs: 2,
      event: {
        type: "game.build",
        roundId: input.result.roundId ?? "",
        phase: "repaired",
        buildId: input.client.buildId ?? "",
        digest: input.client.buildId ?? "",
        sourceDigest: replay.sourceDigest,
      },
    },
  ];
  const receipt = publicReceipt({ ...input, events });
  expect(receipt.validationReplay).toMatchObject({
    frameCount: 1,
    sourceDigest: replay.sourceDigest,
    buildDigest: input.client.buildId,
  });
  expect(receipt.validationReplay?.framesDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.validationReplay).not.toHaveProperty("frames");
  expect(() => publicReceipt({ ...input, events: events.slice(0, 1) })).toThrow(
    /not bound/,
  );
});
it("retains a verified late fix without awarding a race point", () => {
  const input = verified();
  const receipt = publicReceipt({
    ...input,
    result: {
      ...input.result,
      winner: null,
      reason: "round-limit",
      scores: { chat: 0, codex: 0 },
    },
  });
  expect(receipt.reason).toBe("round-limit");
  expect(receipt.winner).toBeNull();
  expect(receipt.scores.codex).toBe(0);
});
it("keeps viewer labels stable with a private mode-0600 key and receipts append-only", async () => {
  const path = await directory();
  const key = await viewerKey(path);
  expect(await viewerKey(path)).toEqual(key);
  expect((await stat(join(path, "round-viewer-key"))).mode & 0o777).toBe(0o600);
  expect(viewerLabel("a", key)).not.toBe(viewerLabel("b", key));
  const receipt = publicReceipt(verified());
  const file = await saveReceipt(path, receipt);
  await saveReceipt(path, receipt);
  await expect(
    saveReceipt(path, { ...receipt, winner: "chat" }),
  ).rejects.toThrow(/overwrite/);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(receipt);
});

it("loads the most recent verified receipt across invocations and never skips an unavailable legacy timing", async () => {
  const path = await directory();
  const receipt = publicReceipt(verified());
  const first = { ...receipt, completedAt: "2026-10-31T10:00:00.000Z" };
  await saveReceipt(path, first);
  expect(await loadPreviousVerifiedRound(path)).toEqual({
    roundId: first.roundId,
    timeToGreenMs: 11003,
  });
  const legacy = {
    ...receipt,
    roundId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    completedAt: "2026-10-31T11:00:00.000Z",
    clock: "legacy-wall-clock-ms",
    durations: receipt.durations
      ? { ...receipt.durations, timeToGreenMs: null }
      : null,
  };
  await saveReceipt(path, legacy);
  expect(await loadPreviousVerifiedRound(path)).toEqual({
    roundId: legacy.roundId,
    timeToGreenMs: null,
  });
  // The same disk baseline is returned to a later independent caller.
  expect(await loadPreviousVerifiedRound(path)).toEqual({
    roundId: legacy.roundId,
    timeToGreenMs: null,
  });
});

it("keeps a newer incompatible timing unavailable and ignores explicitly failed rounds", async () => {
  const path = await directory();
  const receipt = publicReceipt(verified());
  await saveReceipt(path, {
    ...receipt,
    completedAt: "2026-10-31T10:00:00.000Z",
  });
  const incompatible = {
    ...receipt,
    roundId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    completedAt: "2026-10-31T11:00:00.000Z",
    clock: "unrelated-clock",
  };
  await saveReceipt(path, incompatible);
  await saveReceipt(path, {
    ...receipt,
    roundId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    completedAt: "2026-10-31T12:00:00.000Z",
    reason: "repair-failed",
  });
  expect(await loadPreviousVerifiedRound(path)).toEqual({
    roundId: incompatible.roundId,
    timeToGreenMs: null,
  });
});

it("distinguishes missing prior receipts from unreadable prior evidence", async () => {
  const path = await directory();
  expect(await loadPreviousVerifiedRound(join(path, "absent"))).toBeNull();
  expect(await loadPreviousVerifiedRound(path)).toBeNull();
  await writeFile(
    join(path, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json"),
    "not json",
  );
  await expect(loadPreviousVerifiedRound(path)).rejects.toThrow();
});

it("retains terminal autopsy evidence without copying unrelated fields or raw viewer names", () => {
  const input = verified();
  const patch = {
    added: 1,
    removed: 1,
    preview: ["-before", "+after"],
    privateNote: "private-name",
  };
  input.result.autopsy = {
    roundId: input.result.roundId ?? "",
    status: "verified",
    reason: null,
    breaker: input.breaker,
    firstCorrectGuesser: "viewer-aaaaaaaaaaaaaaaa",
    displayNames: {
      breaker: "private-name",
      firstCorrectGuesser: "private-name",
    },
    family: "gravity-sign",
    winner: "codex",
    patch,
    explanation: "The actual explanation",
    durations: input.result.durations ?? {
      headStartMs: null,
      repairMs: null,
      validationMs: null,
      swapMs: null,
      timeToGreenMs: null,
    },
    previousRoundId: null,
    deltaMs: null,
    regressionTest: null,
    regressionError: null,
  };
  Object.assign(input.result.autopsy, { privateNote: "private-name" });
  const receipt = publicReceipt(input);
  expect(receipt.firstCorrectGuesser).toBe("viewer-aaaaaaaaaaaaaaaa");
  expect(receipt.autopsy?.patch).toEqual({
    added: 1,
    removed: 1,
    preview: ["-before", "+after"],
  });
  expect(receipt.autopsy?.explanation).toBe("The actual explanation");
  input.result.autopsy.regressionTest = {
    path: `chat-found/${input.result.roundId}.json`,
    digest: "a".repeat(64),
  };
  Object.assign(input.result.autopsy.regressionTest, {
    privateNote: "private-name",
  });
  const credited = publicReceipt(input);
  expect(credited.autopsy?.regressionTest).toEqual({
    path: `chat-found/${input.result.roundId}.json`,
    digest: "a".repeat(64),
  });
  expect(JSON.stringify(credited)).not.toContain("private-name");
  input.result.autopsy.regressionTest = {
    path: "chat-found/raw-name.json",
    digest: "a".repeat(64),
  };
  expect(() => publicReceipt(input)).toThrow("verified");
  input.result.autopsy.regressionTest = null;
  input.result.autopsy.regressionError = "regression-write-failed";
  expect(publicReceipt(input).autopsy).toMatchObject({
    status: "verified",
    regressionTest: null,
    regressionError: "regression-write-failed",
  });
  input.result.autopsy.regressionError = "token=private-name";
  expect(() => publicReceipt(input)).toThrow("verified");
  input.result.autopsy.regressionError = null;
  expect(JSON.stringify(receipt)).not.toContain("private-name");
  input.result.autopsy.firstCorrectGuesser = "raw-user";
  expect(() => publicReceipt(input)).toThrow("verified");
});
