import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { SCOPES } from "../../twitch/src/auth.js";
import type { PublicIntent, TwitchEvent } from "../../twitch/src/events.js";
import { replayFixtures } from "../../twitch/src/fixtures.js";
import type { RoundSnapshot } from "../src/engine.js";
import { LiveRoundController } from "../src/live.js";
import {
  closeLiveResources,
  createLiveRoundGate,
  parseLiveArguments,
  runLiveCli,
  verifyLiveAuthorization,
} from "../src/live-cli.js";

const stored = { clientId: "public-app", userId: "channel-123" };
const validated = () => ({
  client_id: stored.clientId,
  user_id: stored.userId,
  login: "steve_sociall",
  scopes: [...SCOPES].reverse(),
  expires_in: 3600,
});
const accessToken = vi.fn(async () => "unit-private-token");
function fetcher(value: unknown, status = 200) {
  return vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(value), { status }),
  );
}

it("accepts the refreshed broadcaster token only after exact identity and scope validation", async () => {
  const request = fetcher(validated());
  const result = await verifyLiveAuthorization({
    stored,
    clientId: stored.clientId,
    accessToken,
    fetch: request,
  });
  expect(result).toEqual({
    login: "steve_sociall",
    userId: stored.userId,
    scopes: [...SCOPES].reverse(),
    expiresIn: 3600,
  });
  expect(request).toHaveBeenCalledWith(
    "https://id.twitch.tv/oauth2/validate",
    expect.objectContaining({
      headers: { Authorization: "OAuth unit-private-token" },
      signal: expect.any(AbortSignal),
    }),
  );
  expect(JSON.stringify(result)).not.toContain("unit-private-token");
});
it.each([
  { login: "somebody_else" },
  { user_id: "other-user" },
  { client_id: "other-app" },
  { scopes: SCOPES.slice(1) },
  { scopes: [...SCOPES, "extra:scope"] },
  { scopes: [...SCOPES.slice(1), SCOPES[1]] },
  { expires_in: 0 },
  { expires_in: -1 },
  { expires_in: "3600" },
])(
  "refuses authorization drift without exposing remote details: %j",
  async (changes) => {
    await expect(
      verifyLiveAuthorization({
        stored,
        clientId: stored.clientId,
        accessToken,
        fetch: fetcher({ ...validated(), ...changes }),
      }),
    ).rejects.toThrow("exactly the 11");
  },
);
it("does not refresh a stored authorization belonging to another application", async () => {
  const token = vi.fn(async () => "must-not-be-used");
  const request = fetcher(validated());
  await expect(
    verifyLiveAuthorization({
      stored,
      clientId: "wrong",
      accessToken: token,
      fetch: request,
    }),
  ).rejects.toThrow("another Client ID");
  expect(token).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it("withholds errors containing credentials or remote response content", async () => {
  const request = vi.fn<typeof fetch>(async () => {
    throw new Error("unit-private-token secret remote-body");
  });
  const failure = await verifyLiveAuthorization({
    stored,
    clientId: stored.clientId,
    accessToken,
    fetch: request,
  }).catch((error: unknown) => error);
  expect(String(failure)).not.toMatch(/unit-private-token|remote-body|secret/);
  await expect(
    verifyLiveAuthorization({
      stored,
      clientId: stored.clientId,
      accessToken,
      fetch: fetcher({ message: "unit-private-token" }, 401),
    }),
  ).rejects.toThrow("Twitch validation failed");
});
it("offers help without credential, listener, validator or model operations", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const request = vi.spyOn(globalThis, "fetch");
  try {
    await runLiveCli(["--help"], new AbortController().signal);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("while offline"),
    );
    expect(request).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
    request.mockRestore();
  }
});
it("accepts only the explicit dry-chat flag, rejecting accidental fixture/batch flags", () => {
  expect(parseLiveArguments([])).toEqual({ dryChat: false, help: false });
  expect(parseLiveArguments(["--dry-chat"])).toEqual({
    dryChat: true,
    help: false,
  });
  expect(() => parseLiveArguments(["--run"])).toThrow("round:live");
});
it("attempts every shutdown operation even when stopping a worker or socket fails", async () => {
  const order: number[] = [];
  await expect(
    closeLiveResources([
      () => {
        order.push(1);
        throw new Error("socket failure");
      },
      async () => {
        order.push(2);
        throw new Error("worker failure");
      },
      async () => {
        order.push(3);
      },
      () => {
        order.push(4);
      },
    ]),
  ).rejects.toThrow("remaining cleanup operations were attempted");
  expect(order).toEqual([1, 2, 3, 4]);
});
it("waits for orderly shutdown completion", async () => {
  const operation = vi.fn(async () => {});
  await closeLiveResources([operation]);
  expect(operation).toHaveBeenCalledOnce();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const intent: PublicIntent = {
  kind: "break-requested",
  actor: "viewer",
  source: "chat",
  severity: 1,
  bugCount: 1,
};
function engineDouble() {
  let active = false;
  const done = deferred<RoundSnapshot>();
  const engine = {
    snapshot: () => ({ active }) as RoundSnapshot,
    handlePublic: vi.fn((value: PublicIntent) => {
      if (value.kind === "break-requested") active = true;
    }),
    handlePrivate: vi.fn(() => {
      active = true;
      return { accepted: true };
    }),
    waitForRound: () => done.promise,
  };
  return {
    engine,
    finish: () => {
      active = false;
      done.resolve({ active: false, roundId: "complete" } as RoundSnapshot);
    },
  };
}
it("holds the admission gate through receipt persistence after engine activity ends", async () => {
  const { engine, finish } = engineDouble();
  const saved = deferred<void>();
  const complete = vi.fn(async () => saved.promise);
  const failed = vi.fn();
  const gate = createLiveRoundGate(engine, complete, failed);
  gate.adapter.handlePublic(intent);
  expect(gate.adapter.snapshot().active).toBe(true);
  finish();
  await Promise.resolve();
  expect(complete).toHaveBeenCalledOnce();
  gate.adapter.handlePublic(intent);
  gate.adapter.handlePrivate({
    kind: "sabotage-selected",
    actor: "viewer",
    family: "jump-buffer",
  });
  expect(engine.handlePublic).toHaveBeenCalledOnce();
  expect(engine.handlePrivate).not.toHaveBeenCalled();
  expect(gate.adapter.snapshot().active).toBe(true);
  saved.resolve();
  await gate.drain();
  expect(gate.adapter.snapshot().active).toBe(false);
  expect(failed).not.toHaveBeenCalled();
});
it("continues enum guesses while a round is active and settles private starts", async () => {
  const { engine, finish } = engineDouble();
  const complete = vi.fn(async () => {});
  const gate = createLiveRoundGate(engine, complete, vi.fn());
  gate.adapter.handlePrivate({
    kind: "sabotage-selected",
    actor: "viewer",
    family: "jump-buffer",
  });
  gate.adapter.handlePublic({
    kind: "guess-submitted",
    actor: "viewer",
    word: "gravity-sign",
  });
  expect(engine.handlePrivate).toHaveBeenCalledOnce();
  expect(engine.handlePublic).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "guess-submitted" }),
  );
  finish();
  await gate.drain();
  expect(complete).toHaveBeenCalledOnce();
});
it("reports a receipt failure once instead of leaving an unhandled promise", async () => {
  const { engine, finish } = engineDouble();
  const failure = new Error("disk refused");
  const failed = vi.fn();
  const gate = createLiveRoundGate(
    engine,
    async () => {
      throw failure;
    },
    failed,
  );
  gate.adapter.handlePublic(intent);
  finish();
  await gate.drain();
  expect(failed).toHaveBeenCalledExactlyOnceWith(failure);
});
it("allows fixture-replayed commands through the real live controller and persistence gate", async () => {
  const values = JSON.parse(
    readFileSync(
      new URL("../../twitch/fixtures/session.json", import.meta.url),
      "utf8",
    ),
  ) as TwitchEvent[];
  const first = values[0];
  if (first?.type !== "channel.chat.message")
    throw new Error("missing chat fixture");
  const { engine, finish } = engineDouble();
  const completed = vi.fn(async () => {});
  const gate = createLiveRoundGate(engine, completed, vi.fn());
  const controller = new LiveRoundController({
    broadcasterId: first.event.broadcaster_user_id,
    botUserId: "separate-bot",
    identify: () => "viewer-1234567890abcdef",
    record: () => {},
    dryChat: true,
    helix: {
      isLive: async () => false,
      chat: async () => "unused",
      marker: async () => {},
      clip: async () => {},
      pin: async () => {},
    },
  });
  controller.attach(gate.adapter);
  replayFixtures([first], controller.handler);
  expect(engine.handlePublic).toHaveBeenCalledOnce();
  expect(engine.handlePublic).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "break-requested" }),
  );
  finish();
  await gate.drain();
  await controller.close();
  expect(completed).toHaveBeenCalledOnce();
});
