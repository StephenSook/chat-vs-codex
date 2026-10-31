import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { initialState } from "../../pit-wall/src/protocol.js";
import type { RoundEnvelope, RoundEvent } from "../src/contracts.js";
import { projectPitWall, startPitWall } from "../src/pit-wall.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
function envelope(event: RoundEvent): RoundEnvelope {
  return { sequence: 1, serverTimeMs: 100, event };
}
async function setup(now = () => 100) {
  let announcement = "";
  const action = vi.fn(() => ({ accepted: true, reason: "vetoed" }));
  const record = vi.fn();
  const gateway = await startPitWall({
    port: 0,
    now,
    action,
    record,
    announce: (line) => {
      announcement = line;
    },
  });
  closes.push(() => gateway.close());
  const code = /code: (\d{6})/.exec(announcement)?.[1];
  if (!code) throw new Error("No pairing code");
  return { gateway, code, action, record };
}
async function phone(port: number) {
  // Match the explicit RN native header, including Android's header path.
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
    origin: "pit-wall-native",
  });
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  socket.on("message", (bytes) => {
    const frame = JSON.parse(bytes.toString());
    const waiting = waiters.shift();
    if (waiting) waiting(frame);
    else queue.push(frame);
  });
  await once(socket, "open");
  closes.push(async () => {
    socket.terminate();
  });
  return {
    socket,
    send: (v: unknown) => socket.send(JSON.stringify(v)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise<unknown>((resolve) => waiters.push(resolve)),
  };
}
it("pairs on its separate port, authenticates reconnect and logs actions without tokens", async () => {
  const { gateway, code, action, record } = await setup();
  expect(gateway.port).not.toBe(4317);
  const p = await phone(gateway.port);
  p.send({ type: "pair", code });
  const paired = (await p.next()) as { type: string; token: string };
  expect(paired.type).toBe("paired");
  expect(paired.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await p.next()).toMatchObject({
    type: "state",
    state: initialState(),
  });
  const a = { type: "action", id: "one", roundId: "r", action: "veto" };
  p.send(a);
  expect(await p.next()).toMatchObject({ type: "ack", accepted: true });
  p.send(a);
  await p.next();
  expect(action).toHaveBeenCalledTimes(1);
  p.send({ ...a, roundId: "other" });
  expect(await p.next()).toMatchObject({
    accepted: false,
    reason: "id-reused",
  });
  const reconnected = await phone(gateway.port);
  reconnected.send({ type: "auth", token: paired.token });
  expect(await reconnected.next()).toMatchObject({ type: "state" });
  reconnected.send(a);
  expect(await reconnected.next()).toMatchObject({ accepted: true });
  expect(action).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(record.mock.calls)).not.toContain(paired.token);
  expect(JSON.stringify(record.mock.calls)).not.toContain(code);
});
it("denies unauthenticated actions, wrong/expired codes, invalid enum and foreign origins", async () => {
  let now = 100;
  const { gateway, code, action } = await setup(() => now);
  const invalidCode = await phone(gateway.port);
  invalidCode.send({
    type: "pair",
    code: code === "111111" ? "222222" : "111111",
  });
  expect(await invalidCode.next()).toMatchObject({ reason: "pairing-refused" });
  const invalidToken = await phone(gateway.port);
  invalidToken.send({ type: "auth", token: "0".repeat(64) });
  expect(await invalidToken.next()).toMatchObject({ reason: "unauthorized" });
  const stranger = await phone(gateway.port);
  stranger.send({ type: "action", id: "one", roundId: "r", action: "veto" });
  expect(await stranger.next()).toMatchObject({
    type: "error",
    reason: "unauthorized",
  });
  const p = await phone(gateway.port);
  p.send({ type: "pair", code });
  await p.next();
  await p.next();
  p.send({
    type: "action",
    id: "bad",
    roundId: "r",
    action: "hint",
    family: "free text",
  });
  expect(await p.next()).toMatchObject({
    type: "error",
    reason: "invalid-frame",
  });
  expect(action).not.toHaveBeenCalled();
  now += 300_001;
  const expired = await phone(gateway.port);
  expired.send({ type: "pair", code });
  expect(await expired.next()).toMatchObject({ reason: "pairing-refused" });
  const browser = new WebSocket(`ws://127.0.0.1:${gateway.port}`, {
    origin: "https://evil.example",
  });
  await expect(once(browser, "open")).rejects.toThrow();
});

it("refuses the overlay port before opening a listener", async () => {
  await expect(
    startPitWall({
      port: 4317,
      action: () => ({ accepted: false, reason: "none" }),
      record: () => {},
      announce: () => {},
    }),
  ).rejects.toThrow("never");
});
it("projects only real observed state and excludes source/secret mutation fields", () => {
  let s = initialState();
  const apply = (event: RoundEvent) => {
    s = projectPitWall(s, envelope(event));
  };
  apply({
    type: "round.state",
    phase: "preparing",
    roundId: "r",
    headStartEndsAt: null,
    winner: null,
    reason: null,
  });
  apply({
    type: "overlay",
    event: { type: "round.started", id: "r", number: 7, atMs: 100 },
  });
  apply({
    type: "overlay",
    event: { type: "bug.active", roundId: "r", intensity: 1 },
  });
  apply({
    type: "round.state",
    phase: "head-start",
    roundId: "r",
    headStartEndsAt: 15100,
    winner: null,
    reason: null,
  });
  apply({
    type: "overlay",
    event: {
      type: "codex.step",
      roundId: "stale",
      id: "a",
      step: { kind: "tests" },
      status: "running",
      attempt: 1,
      total: 1,
    },
  });
  expect(s.step).toBeNull();
  apply({
    type: "overlay",
    event: {
      type: "codex.step",
      roundId: "r",
      id: "a",
      step: { kind: "tests" },
      status: "running",
      attempt: 1,
      total: 1,
    },
  });
  apply({ type: "overlay", event: { type: "simulation.death" } });
  expect(s).toMatchObject({
    number: 7,
    headStartEndsAt: 15100,
    bug: "active",
    deaths: 1,
    step: "Running tests",
  });
  const before = s;
  apply({
    type: "game.build",
    roundId: "r",
    buildId: "secret",
    digest: "secret",
    phase: "broken",
  });
  expect(s).toBe(before);
});

it("delivers round events and deduplicates live browser deaths across reconnects", async () => {
  const { gateway, code } = await setup();
  gateway.publish(
    envelope({
      type: "round.state",
      phase: "preparing",
      roundId: "r",
      headStartEndsAt: null,
      winner: null,
      reason: null,
    }),
  );
  gateway.publish(
    envelope({
      type: "round.state",
      phase: "head-start",
      roundId: "r",
      headStartEndsAt: 15100,
      winner: null,
      reason: null,
    }),
  );
  gateway.death("r", "a");
  gateway.death("r", "a");
  gateway.death("old", "b");
  const p = await phone(gateway.port);
  p.send({ type: "pair", code });
  await p.next();
  expect(await p.next()).toMatchObject({
    type: "state",
    state: { deaths: 1, phase: "head-start" },
  });
  gateway.publish(
    envelope({
      type: "overlay",
      event: { type: "bug.active", roundId: "r", intensity: 1 },
    }),
  );
  expect(await p.next()).toMatchObject({
    type: "state",
    state: { bug: "active", deaths: 1 },
  });
});
