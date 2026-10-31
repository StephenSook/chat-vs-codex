import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initialBroadcast } from "../../../apps/overlay/src/events.js";
import type { ClientSnapshot } from "../src/client.js";
import type { RoundSnapshot } from "../src/engine.js";
import {
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
