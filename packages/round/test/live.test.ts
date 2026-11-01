import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TwitchEvent } from "../../twitch/src/events.js";
import { replayFixtures } from "../../twitch/src/fixtures.js";
import type { LiveHelix } from "../../twitch/src/helix.js";
import { TwitchRefusal } from "../../twitch/src/helix.js";
import type {
  GameArtifact,
  PreparedGame,
  RoundAutopsy,
  RoundEvent,
} from "../src/contracts.js";
import { RoundEngine } from "../src/engine.js";
import { BOT_REPLY_PREFIXES, LiveRoundController } from "../src/live.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../twitch/fixtures/session.json", import.meta.url),
    "utf8",
  ),
) as TwitchEvent[];
function chat(text: string, actor = "fixture-viewer", id = text): TwitchEvent {
  const base = fixtures[0];
  if (base?.type !== "channel.chat.message")
    throw new Error("chat fixture missing");
  return {
    type: base.type,
    event: {
      ...base.event,
      chatter_user_id: actor,
      message_id: id,
      message: { text, fragments: [] },
    },
  };
}
function setup(
  options: {
    live?: boolean;
    dryChat?: boolean;
    refusal?: boolean;
    allowBroadcasterTest?: boolean;
  } = {},
) {
  let now = 0;
  let active = false;
  const helix: LiveHelix = {
    isLive: vi.fn(async () => options.live ?? false),
    chat: vi.fn(async () => "sent-id"),
    marker: vi.fn(async () => {
      if (options.refusal) throw new TwitchRefusal(403, "VOD disabled");
    }),
    clip: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
  };
  const logs: Record<string, unknown>[] = [];
  const controller = new LiveRoundController({
    broadcasterId: "fixture-channel",
    botUserId: "fixture-channel",
    helix,
    identify: () => "viewer-1234567890abcdef",
    record: (event) => logs.push(event),
    now: () => now,
    ...(options.allowBroadcasterTest === undefined
      ? {}
      : { allowBroadcasterTest: options.allowBroadcasterTest }),
    ...(options.dryChat === undefined ? {} : { dryChat: options.dryChat }),
  });
  const engine = {
    snapshot: () => ({ active }),
    handlePublic: vi.fn(),
    handlePrivate: vi.fn(),
  };
  controller.attach(engine);
  return {
    controller,
    engine,
    helix,
    logs,
    setNow: (value: number) => {
      now = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
  };
}
const broken: RoundEvent = {
  type: "game.build",
  roundId: "round-1",
  buildId: "a",
  digest: "a",
  phase: "broken",
};
function autopsy(verified = true): RoundEvent {
  const card: RoundAutopsy = {
    roundId: "round-1",
    status: verified ? "verified" : "rolled-back",
    reason: null,
    breaker: "viewer-1234567890abcdef",
    firstCorrectGuesser: null,
    family: "gravity-sign",
    winner: verified ? "codex" : null,
    patch: null,
    explanation: null,
    headline: null,
    durations: {
      headStartMs: 15000,
      repairMs: 15330,
      validationMs: 2330,
      swapMs: 10,
      timeToGreenMs: verified ? 17670 : null,
    },
    previousRoundId: null,
    deltaMs: null,
    regressionTest: verified
      ? { path: "chat-found/round-1.json", digest: "a".repeat(64) }
      : null,
    regressionError: null,
  };
  return {
    type: "overlay",
    event: { type: "round.autopsy", roundId: card.roundId, autopsy: card },
  };
}
describe("live Twitch fixture entry point", () => {
  it("creates a titled clip from the measured verified autopsy and posts only its returned URL", async () => {
    const { controller, helix, logs } = setup({ live: true });
    vi.mocked(helix.clip).mockResolvedValue({
      id: "clip-1",
      url: "https://clips.twitch.tv/clip-1",
      titlePath: "fallback",
      titleRefusal: "Twitch 400: title unsupported",
    });
    controller.observe({ ...broken, phase: "repaired" });
    expect(helix.clip).not.toHaveBeenCalled();
    controller.observe(autopsy());
    controller.observe(autopsy());
    await controller.flush();
    expect(helix.clip).toHaveBeenCalledExactlyOnceWith(
      "Codex fixed gravity-sign in 17.7 s",
    );
    expect(helix.chat).toHaveBeenCalledWith(
      "Clip: https://clips.twitch.tv/clip-1",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        type: "twitch.clip-requested",
        roundId: "round-1",
        titlePath: "fallback",
        titleRefusal: "Twitch 400: title unsupported",
      }),
    );
  });
  it.each([false, true])(
    "accepts broadcaster commands only with explicit opt-in=%s",
    (allowBroadcasterTest) => {
      const { controller, engine } = setup({ allowBroadcasterTest });
      replayFixtures(
        [
          chat("!break", "fixture-channel"),
          chat("!guess gravity-sign", "fixture-channel"),
          chat("!guess wrong-family", "fixture-channel"),
          chat("!break gravity-sign", "fixture-channel"),
        ],
        controller.handler,
      );
      expect(
        engine.handlePublic.mock.calls.map(([intent]) => intent.kind),
      ).toEqual(
        allowBroadcasterTest ? ["break-requested", "guess-submitted"] : [],
      );
    },
  );
  it("rejects early prefix echoes and returned message IDs, including shared-chat copies, in broadcaster test mode", async () => {
    const { controller, engine, helix } = setup({ allowBroadcasterTest: true });
    vi.mocked(helix.chat).mockImplementation(async (line) => {
      // EventSub may deliver the app's reply before the HTTP response returns its ID.
      replayFixtures(
        [chat(line, "fixture-channel", "early-echo")],
        controller.handler,
      );
      return "app-reply-id";
    });
    controller.observe(broken);
    await controller.flush();
    const shared = chat(
      "!guess gravity-sign",
      "fixture-channel",
      "shared-copy",
    );
    if (shared.type !== "channel.chat.message")
      throw new Error("Expected chat");
    shared.event.source_message_id = "app-reply-id";
    replayFixtures(
      [
        chat("!break", "fixture-channel", "app-reply-id"),
        shared,
        ...BOT_REPLY_PREFIXES.map((prefix, index) =>
          chat(`${prefix} !break`, "fixture-channel", `prefix-${index}`),
        ),
      ],
      controller.handler,
    );
    expect(engine.handlePublic).not.toHaveBeenCalled();
    replayFixtures(
      [chat("!break", "fixture-channel", "human-command")],
      controller.handler,
    );
    expect(engine.handlePublic).toHaveBeenCalledOnce();
  });
  it("accepts only bare break and enum guesses, never forwards free chat, own messages or malformed commands", () => {
    const { controller, engine } = setup();
    replayFixtures(
      [
        chat("fix the gravity secret text"),
        chat("!break gravity-sign"),
        chat("!hint"),
        chat("!guess anything"),
        chat("!guess gravity-sign please"),
        chat("!break", "fixture-channel"),
        chat("!break"),
        chat("!guess SWAPPED-CONTROLS"),
      ],
      controller.handler,
    );
    expect(engine.handlePublic.mock.calls.map(([intent]) => intent)).toEqual([
      {
        kind: "break-requested",
        source: "chat",
        actor: "fixture-viewer",
        bugCount: 1,
        severity: 1,
      },
      {
        kind: "guess-submitted",
        actor: "fixture-viewer",
        word: "swapped-controls",
      },
    ]);
    expect(engine.handlePrivate).not.toHaveBeenCalled();
  });
  it("one active round, per-user cooldown and deduplication cover chat and secret whisper starts", () => {
    const { controller, engine, setActive, setNow } = setup();
    const whisper = fixtures[1];
    if (!whisper) throw new Error("whisper fixture missing");
    replayFixtures([chat("!break")], controller.handler);
    setActive(true);
    replayFixtures(
      [chat("!break", "other", "two"), whisper],
      controller.handler,
    );
    expect(engine.handlePublic).toHaveBeenCalledTimes(1);
    expect(engine.handlePrivate).not.toHaveBeenCalled();
    setActive(false);
    replayFixtures(
      [{ ...whisper, event: { ...whisper.event, whisper_id: "whisper-two" } }],
      controller.handler,
    );
    expect(engine.handlePrivate).not.toHaveBeenCalled();
    setNow(60_001);
    replayFixtures(
      [
        {
          ...whisper,
          event: { ...whisper.event, whisper_id: "whisper-three" },
        },
      ],
      controller.handler,
    );
    expect(engine.handlePrivate).toHaveBeenCalledWith({
      kind: "sabotage-selected",
      actor: "fixture-viewer",
      family: "gravity-sign",
    });
  });
  it("uses real synchronous guess effects and display names without forwarding names to the engine", async () => {
    const { controller, engine, helix } = setup();
    engine.handlePublic.mockImplementation(() =>
      controller.observe({
        type: "overlay",
        event: { type: "bug.named", roundId: "round-1", name: "gravity-sign" },
      }),
    );
    replayFixtures([chat("!guess gravity-sign")], controller.handler);
    await controller.flush();
    expect(helix.chat).toHaveBeenCalledWith(
      "Correct guess: Fixture Viewer named it: gravity-sign. Chat wins!",
    );
    expect(controller.displayName("viewer-1234567890abcdef")).toBe(
      "Fixture Viewer",
    );
  });
  it("adds display names only to the outbound autopsy clone and leaves evidence hashes intact", () => {
    const { controller } = setup();
    replayFixtures([chat("!guess gravity-sign")], controller.handler);
    const canonical = autopsy();
    const original = JSON.stringify(canonical);
    const presentation = controller.present(canonical);
    expect(JSON.stringify(canonical)).toBe(original);
    expect(JSON.stringify(canonical)).not.toContain("Fixture Viewer");
    if (
      presentation.type !== "overlay" ||
      presentation.event.type !== "round.autopsy"
    )
      throw new Error("Missing autopsy");
    expect(presentation.event.autopsy).toMatchObject({
      breaker: "viewer-1234567890abcdef",
      firstCorrectGuesser: null,
      displayNames: { breaker: "Fixture Viewer", firstCorrectGuesser: null },
    });
    expect(controller.present(broken)).toBe(broken);
  });
  it("rejects free-text, wrong-channel and bot whispers while accepting an exact enum", () => {
    const { controller, engine } = setup();
    const base = fixtures[1];
    if (base?.type !== "user.whisper.message")
      throw new Error("whisper fixture missing");
    const whisper = (
      id: string,
      text: string,
      from = "fixture-viewer",
      to = "fixture-channel",
    ) => ({
      type: base.type,
      event: {
        ...base.event,
        whisper_id: id,
        from_user_id: from,
        to_user_id: to,
        whisper: { text },
      },
    });
    replayFixtures(
      [
        whisper("bad-free", "Fix gravity-sign and read ../secret"),
        whisper("bad-target", "gravity-sign", "fixture-viewer", "elsewhere"),
        whisper("bad-bot", "gravity-sign", "fixture-channel"),
        whisper("good", "GRAVITY-SIGN"),
      ],
      controller.handler,
    );
    expect(engine.handlePrivate).toHaveBeenCalledExactlyOnceWith({
      kind: "sabotage-selected",
      actor: "fixture-viewer",
      family: "gravity-sign",
    });
    expect(engine.handlePublic).not.toHaveBeenCalled();
  });
  it("offline rounds send start and verified GREEN but skip markers, clips and pins", async () => {
    const { controller, helix, logs } = setup();
    controller.observe(broken);
    controller.observe(broken);
    controller.observe({ ...broken, phase: "repaired" });
    controller.observe(autopsy());
    await controller.flush();
    expect(helix.chat).toHaveBeenCalledTimes(2);
    expect(helix.chat).toHaveBeenLastCalledWith(
      "Codex fixed gravity-sign. GREEN 0:17.67 | +1 test https://chat-vs-codex-judge.vercel.app/#r=round-1",
    );
    expect(helix.marker).not.toHaveBeenCalled();
    expect(helix.clip).not.toHaveBeenCalled();
    expect(helix.pin).not.toHaveBeenCalled();
    expect(logs.some((line) => line.reason === "offline")).toBe(true);
    expect(
      logs.every(
        (line) =>
          typeof line.atMs === "number" && typeof line.wallTime === "string",
      ),
    ).toBe(true);
  });
  it("live rounds mark both boundaries, create a clip, and pin the actual sent autopsy message id", async () => {
    const { controller, helix } = setup({ live: true });
    controller.observe(broken);
    controller.observe({ ...broken, phase: "repaired" });
    controller.observe(autopsy());
    await controller.flush();
    expect(helix.marker).toHaveBeenCalledTimes(2);
    expect(helix.clip).toHaveBeenCalledTimes(1);
    expect(helix.pin).toHaveBeenCalledWith("sent-id");
  });
  it("Twitch refusal is nonfatal and records its reason while independent effects still run", async () => {
    const { controller, helix, logs } = setup({ live: true, refusal: true });
    controller.observe(broken);
    controller.observe({ ...broken, phase: "repaired" });
    controller.observe(autopsy());
    await expect(controller.flush()).resolves.toBeUndefined();
    expect(logs.filter((line) => line.type === "twitch.refused")).toHaveLength(
      2,
    );
    expect(
      logs.some((line) => String(line.reason).includes("VOD disabled")),
    ).toBe(true);
    expect(helix.clip).toHaveBeenCalledOnce();
    expect(helix.pin).toHaveBeenCalledOnce();
  });
  it("dry chat logs all outgoing lines and performs no Helix writes or live checks", async () => {
    const { controller, helix, logs } = setup({ live: true, dryChat: true });
    controller.observe(broken);
    controller.observe({ ...broken, phase: "repaired" });
    controller.observe(autopsy());
    await controller.flush();
    expect(logs.filter((line) => line.type === "twitch.dry-chat")).toHaveLength(
      2,
    );
    for (const call of Object.values(helix))
      expect(call).not.toHaveBeenCalled();
  });
  it("failed rounds announce failure once and never create fix artifacts", async () => {
    const { controller, helix } = setup({ live: true });
    controller.observe(autopsy(false));
    controller.observe(autopsy(false));
    await controller.close();
    expect(helix.chat).toHaveBeenCalledWith(
      "Codex failed. The game was rolled back. https://chat-vs-codex-judge.vercel.app/#r=round-1",
    );
    expect(helix.clip).not.toHaveBeenCalled();
    expect(helix.pin).not.toHaveBeenCalled();
    replayFixtures([chat("!break")], controller.handler);
  });
  it.each(["rollback-failed", "rollback-timeout"])(
    "does not claim rollback succeeded after %s",
    async (reason) => {
      const { controller, helix } = setup();
      const event = autopsy(false);
      if (event.type !== "overlay" || event.event.type !== "round.autopsy")
        throw new Error("Missing autopsy");
      event.event.autopsy.reason = reason;
      controller.observe(event);
      await controller.flush();
      expect(helix.chat).toHaveBeenCalledExactlyOnceWith(
        "Codex failed. Restore needs attention. https://chat-vs-codex-judge.vercel.app/#r=round-1",
      );
      expect(helix.clip).not.toHaveBeenCalled();
    },
  );
});

describe("fixture controller and real round engine integration", () => {
  it.each([
    { correct: false, allowBroadcasterTest: false },
    { correct: true, allowBroadcasterTest: false },
    { correct: false, allowBroadcasterTest: true },
    { correct: true, allowBroadcasterTest: true },
  ])(
    "completes the causal round with correct guess=$correct and broadcaster test=$allowBroadcasterTest",
    async ({ correct, allowBroadcasterTest }) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const { controller, helix } = setup({ allowBroadcasterTest });
      const actor = allowBroadcasterTest ? "fixture-channel" : "fixture-viewer";
      const events: RoundEvent[] = [];
      // This is an explicit fake of the runtime's verified-build contract. No SDK,
      // network, source edit or OS-profile validation is represented as a real run.
      const source = (id: string): GameArtifact => ({
        id,
        code: id,
        digest: id,
      });
      const game: PreparedGame = {
        family: "gravity-sign",
        clean: source("clean"),
        broken: source("broken"),
        close: vi.fn(async () => {}),
        repair: vi.fn(async ({ hint, observe }) => {
          expect(hint).toBe(correct ? "gravity-sign" : "swapped-controls");
          const phase = (
            name:
              | "thread-started"
              | "patch-ready"
              | "validation-started"
              | "validation-passed",
          ) =>
            observe?.({
              type: "runtime.phase",
              phase: name,
              atMs: Date.now(),
              wallTime: new Date().toISOString(),
            });
          const threadStartedAtMs = Date.now();
          phase("thread-started");
          await new Promise<void>((done) => setTimeout(done, 200));
          const patchReadyAtMs = Date.now();
          phase("patch-ready");
          phase("validation-started");
          const validationStartedAtMs = Date.now();
          await new Promise<void>((done) => setTimeout(done, 100));
          const validationFinishedAtMs = Date.now();
          phase("validation-passed");
          return {
            ...source("repaired"),
            timings: {
              threadStartedAtMs,
              patchReadyAtMs,
              validationStartedAtMs,
              validationFinishedAtMs,
            },
          };
        }),
      };
      const engine = new RoundEngine({
        ...(allowBroadcasterTest
          ? { trigger: "broadcaster-test" as const }
          : {}),
        now: () => Date.now(),
        identify: () => "viewer-1234567890abcdef",
        runtime: { prepare: async () => game },
        publish: (event) => {
          events.push(event);
          controller.observe(event);
        },
        activate: async (artifact, phase, roundId) => {
          const event: RoundEvent = {
            type: "game.build",
            roundId,
            phase,
            buildId: artifact.id,
            digest: artifact.digest,
          };
          events.push(event);
          controller.observe(event);
        },
      });
      controller.attach(engine);
      try {
        replayFixtures([chat("!break", actor)], controller.handler);
        await vi.advanceTimersByTimeAsync(0);
        expect(engine.snapshot().phase).toBe("head-start");
        expect(game.repair).not.toHaveBeenCalled();
        replayFixtures(
          [
            chat("Free text must never become a hint", "noise"),
            chat(
              `!guess ${correct ? "gravity-sign" : "swapped-controls"}`,
              actor,
              "guess-1",
            ),
            ...(correct ? [chat("!guess gravity-sign", actor, "guess-2")] : []),
          ],
          controller.handler,
        );
        await vi.advanceTimersByTimeAsync(15_000);
        expect(game.repair).toHaveBeenCalledTimes(1);
        expect(engine.snapshot().phase).toBe("repairing");
        await vi.advanceTimersByTimeAsync(200);
        expect(engine.snapshot().phase).toBe("validating");
        expect(helix.chat).not.toHaveBeenCalledWith(
          expect.stringContaining("Codex fixed"),
        );
        await vi.advanceTimersByTimeAsync(100);
        const result = await engine.waitForRound();
        await controller.flush();
        expect(result.phase).toBe("resolved");
        expect(result.trigger).toBe(
          allowBroadcasterTest ? "broadcaster-test" : undefined,
        );
        expect(result.autopsy?.trigger).toBe(result.trigger);
        expect(
          events
            .filter((event) => event.type !== "game.build")
            .every((event) => event.trigger === result.trigger),
        ).toBe(true);
        expect(result.scores).toEqual(
          correct ? { chat: 1, codex: 0 } : { chat: 0, codex: 1 },
        );
        expect(result.autopsy?.durations).toEqual({
          headStartMs: 15000,
          repairMs: 200,
          validationMs: 100,
          swapMs: 0,
          timeToGreenMs: 300,
        });
        expect(helix.chat).toHaveBeenCalledWith(
          "Something broke. Chat has 15 s.",
        );
        expect(helix.chat).toHaveBeenLastCalledWith(
          `Codex fixed gravity-sign. GREEN 0:00.30 https://chat-vs-codex-judge.vercel.app/#r=${result.roundId}`,
        );
        expect(
          vi
            .mocked(helix.chat)
            .mock.calls.filter(([line]) => line.includes("Chat wins!")),
        ).toHaveLength(correct ? 1 : 0);
        expect(
          events
            .filter((event) => event.type === "game.build")
            .map((event) => event.phase),
        ).toEqual(["broken", "repaired"]);
        expect(game.close).toHaveBeenCalledTimes(1);
        expect(
          vi
            .mocked(helix.chat)
            .mock.calls.every(([line]) =>
              BOT_REPLY_PREFIXES.some((prefix) => line.startsWith(prefix)),
            ),
        ).toBe(true);
      } finally {
        await engine.stop();
        await controller.close();
        vi.useRealTimers();
      }
    },
  );
});
