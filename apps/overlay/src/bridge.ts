import type {
  RoundAutopsy,
  RoundEnvelope,
  RoundEvent,
} from "../../../packages/round/src/contracts.js";
import {
  CODEX_ACTIONS,
  type OverlayEvent,
  type OverlayEventBus,
} from "./events.js";
import { validGhostReplay } from "./ghost.js";
import type { SimulationPlayer } from "./simulation.js";

type BuildEvent = Extract<RoundEvent, { type: "game.build" }>;
type StateEvent = Extract<RoundEvent, { type: "round.state" }>;

export function bridgeOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Round bridge must use a loopback HTTP origin");
  return url.origin;
}

export async function loadVerifiedBuild(
  origin: string,
  build: BuildEvent,
  dependencies: {
    fetch?: typeof fetch;
    importModule?: (code: string) => Promise<unknown>;
  } = {},
): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(build.digest) || build.buildId !== build.digest)
    throw new Error("Build id must equal its SHA-256 digest");
  const response = await (dependencies.fetch ?? fetch)(
    `${bridgeOrigin(origin)}/api/builds/${build.buildId}.js`,
  );
  if (!response.ok)
    throw new Error(`Build download failed: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== build.digest)
    throw new Error("Downloaded build SHA-256 mismatch");
  const code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (dependencies.importModule) return dependencies.importModule(code);
  const url = URL.createObjectURL(
    new Blob([code], { type: "text/javascript" }),
  );
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function validateOverlay(event: unknown): event is OverlayEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  const integer = (key: string) =>
    Number.isSafeInteger(e[key]) && Number(e[key]) >= 0;
  switch (e.type) {
    case "round.preparing":
      return typeof e.id === "string";
    case "round.started":
      return (
        typeof e.id === "string" &&
        integer("number") &&
        Number.isFinite(e.atMs) &&
        (e.headStartMs === undefined ||
          (Number.isFinite(e.headStartMs) && Number(e.headStartMs) >= 0))
      );
    case "bug.active":
      return typeof e.roundId === "string" && Number.isFinite(e.intensity);
    case "bug.named":
      return typeof e.roundId === "string" && typeof e.name === "string";
    case "tests.green":
      return typeof e.roundId === "string";
    case "round.ghost":
      return typeof e.roundId === "string" && validGhostReplay(e.replay);
    case "round.autopsy":
      return (
        typeof e.roundId === "string" &&
        validAutopsy(e.autopsy) &&
        e.autopsy.roundId === e.roundId
      );
    case "score.changed":
      return integer("chat") && integer("codex");
    case "simulation.death":
      return true;
    case "codex.step": {
      const step = e.step as Record<string, unknown> | undefined;
      return (
        typeof e.roundId === "string" &&
        typeof e.id === "string" &&
        ["running", "done", "failed"].includes(String(e.status)) &&
        integer("attempt") &&
        integer("total") &&
        !!step &&
        (step.kind === "replay" ||
          step.kind === "tests" ||
          (step.kind === "activity" &&
            CODEX_ACTIONS.some((action) => action === step.action)) ||
          (step.kind === "reading" && typeof step.path === "string") ||
          (step.kind === "patch" &&
            Number.isSafeInteger(step.added) &&
            Number(step.added) >= 0 &&
            Number.isSafeInteger(step.removed) &&
            Number(step.removed) >= 0))
      );
    }
    default:
      return false;
  }
}

function validAutopsy(value: unknown): value is RoundAutopsy {
  if (!value || typeof value !== "object") return false;
  const record = value as RoundAutopsy;
  const alias = (actor: unknown) =>
    actor === null ||
    (typeof actor === "string" && /^viewer-[a-f0-9]{16}$/.test(actor));
  const measured = (time: unknown) =>
    time === null ||
    (typeof time === "number" && Number.isFinite(time) && time >= 0);
  const nullableText = (text: unknown) =>
    text === null || typeof text === "string";
  const patch = record.patch;
  const regression = record.regressionTest;
  const safeRoundId =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  return (
    typeof record.roundId === "string" &&
    ["verified", "rolled-back"].includes(record.status) &&
    nullableText(record.reason) &&
    alias(record.breaker) &&
    alias(record.firstCorrectGuesser) &&
    (record.family === null ||
      [
        "gravity-sign",
        "collision-off-by-one",
        "swapped-controls",
        "coyote-never-expires",
        "jump-buffer",
        "enemy-ledge-turn",
      ].includes(record.family)) &&
    (record.winner === null || ["chat", "codex"].includes(record.winner)) &&
    (patch === null ||
      (!!patch &&
        Number.isSafeInteger(patch.added) &&
        patch.added >= 0 &&
        Number.isSafeInteger(patch.removed) &&
        patch.removed >= 0 &&
        Array.isArray(patch.preview) &&
        patch.preview.length <= 4 &&
        patch.preview.every((line) => typeof line === "string"))) &&
    nullableText(record.explanation) &&
    !!record.durations &&
    [
      "headStartMs",
      "repairMs",
      "validationMs",
      "swapMs",
      "timeToGreenMs",
    ].every((key) =>
      measured(record.durations[key as keyof typeof record.durations]),
    ) &&
    nullableText(record.previousRoundId) &&
    nullableText(record.regressionError) &&
    (regression === null ||
      (!!regression &&
        typeof record.roundId === "string" &&
        safeRoundId.test(record.roundId) &&
        regression.path === `chat-found/${record.roundId}.json` &&
        typeof regression.digest === "string" &&
        /^[a-f0-9]{64}$/.test(regression.digest) &&
        record.regressionError === null)) &&
    (record.deltaMs === null ||
      (typeof record.deltaMs === "number" && Number.isFinite(record.deltaMs)))
  );
}

export function parseRoundEnvelope(value: unknown): RoundEnvelope {
  if (!value || typeof value !== "object")
    throw new Error("Invalid round envelope");
  const e = value as RoundEnvelope;
  if (
    !Number.isSafeInteger(e.sequence) ||
    e.sequence < 1 ||
    !Number.isFinite(e.serverTimeMs) ||
    (e.atMs !== undefined && !Number.isFinite(e.atMs)) ||
    (e.deliveryAtMs !== undefined && !Number.isFinite(e.deliveryAtMs)) ||
    (e.wallTime !== undefined &&
      (typeof e.wallTime !== "string" ||
        !Number.isFinite(Date.parse(e.wallTime)))) ||
    !e.event ||
    typeof e.event !== "object"
  )
    throw new Error("Invalid round sequence or server clock");
  const event = e.event;
  if (event.type === "overlay" && validateOverlay(event.event)) return e;
  if (
    event.type === "game.build" &&
    typeof event.roundId === "string" &&
    typeof event.buildId === "string" &&
    typeof event.digest === "string" &&
    (event.sourceDigest === undefined ||
      (typeof event.sourceDigest === "string" &&
        /^[a-f0-9]{64}$/.test(event.sourceDigest))) &&
    ["broken", "repaired", "rollback"].includes(event.phase)
  )
    return e;
  if (
    event.type === "round.state" &&
    (event.roundId === null || typeof event.roundId === "string") &&
    [
      "idle",
      "preparing",
      "head-start",
      "repairing",
      "validating",
      "swapping",
      "resolved",
      "rolled-back",
    ].includes(event.phase) &&
    (event.reason === null || typeof event.reason === "string") &&
    (event.headStartEndsAt === null ||
      Number.isFinite(event.headStartEndsAt)) &&
    (event.winner === null || ["chat", "codex"].includes(event.winner))
  )
    return e;
  throw new Error("Invalid round event");
}

export interface RoundBridgeOptions {
  simulation: SimulationPlayer;
  events: OverlayEventBus;
  loadBuild: (event: BuildEvent) => Promise<unknown>;
  now?: () => number;
  onError?: (error: Error) => void;
  onState?: (event: StateEvent) => void;
  onBuild?: (event: BuildEvent) => void;
  onConnection?: (connected: boolean) => void;
}

/** Serializes asynchronous imports with event publication, including SSE replay after reconnect. */
export class OrderedRoundBridge {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private roundId: string | null = null;
  private readonly seenRounds = new Set<string>();
  private faultRound: string | null = null;
  private replaySourceDigest: string | null = null;
  private closed = false;

  constructor(private readonly options: RoundBridgeOptions) {}

  receive(value: unknown): Promise<void> {
    let envelope: RoundEnvelope;
    try {
      envelope = parseRoundEnvelope(value);
    } catch (error) {
      return this.fail(error);
    }
    if (this.closed || envelope.sequence <= this.sequence)
      return Promise.resolve();
    if (this.sequence > 0 && envelope.sequence !== this.sequence + 1)
      return this.fail(
        new Error(
          "Round event sequence gap; reload to recover the current build",
        ),
      );
    this.sequence = envelope.sequence;
    const receivedAtMs = (this.options.now ?? (() => performance.now()))();
    const event = envelope.event;
    const introduced =
      event.type === "overlay" &&
      (event.event.type === "round.started" ||
        event.event.type === "round.preparing")
        ? event.event.id
        : event.type === "round.state" && event.phase === "preparing"
          ? event.roundId
          : null;
    if (
      introduced &&
      introduced !== this.roundId &&
      !this.seenRounds.has(introduced)
    ) {
      this.roundId = introduced;
      this.seenRounds.add(introduced);
      this.faultRound = null;
      this.replaySourceDigest = null;
    }
    const receivedRoundId = this.roundId;
    const task = async () => {
      if (this.closed) return;
      const roundId =
        event.type === "overlay"
          ? event.event.type === "round.started" ||
            event.event.type === "round.preparing"
            ? event.event.id
            : "roundId" in event.event
              ? event.event.roundId
              : receivedRoundId
          : event.roundId;
      if (roundId !== null && roundId !== this.roundId) return;
      if (this.faultRound !== null && roundId === this.faultRound) return;
      try {
        if (event.type === "game.build") {
          if (
            event.phase === "repaired" &&
            (event.sourceDigest !== undefined ||
              this.replaySourceDigest !== null) &&
            event.sourceDigest !== this.replaySourceDigest
          )
            throw new Error(
              "Repaired build source does not match the observed validated replay",
            );
          const module = await this.options.loadBuild(event);
          if (this.closed || event.roundId !== this.roundId) return;
          this.options.simulation.install(module);
          if (event.phase === "rollback") this.replaySourceDigest = null;
          this.options.onBuild?.(event);
        } else if (event.type === "overlay") {
          if (event.event.type === "round.ghost")
            this.replaySourceDigest = event.event.replay.sourceDigest;
          this.options.events.publish(
            event.event.type === "round.started"
              ? {
                  ...event.event,
                  atMs:
                    receivedAtMs +
                    event.event.atMs -
                    (envelope.deliveryAtMs ??
                      envelope.atMs ??
                      envelope.serverTimeMs),
                }
              : event.event,
          );
        } else {
          if (event.phase === "preparing" && event.roundId !== null)
            this.options.events.publish({
              type: "round.preparing",
              id: event.roundId,
            });
          this.options.onState?.(event);
        }
      } catch (error) {
        if (this.closed || roundId !== this.roundId) return;
        if (roundId === this.roundId) this.faultRound = this.roundId;
        throw error;
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next.catch((error: unknown) => this.fail(error));
  }

  close(): void {
    this.closed = true;
  }

  private fail(error: unknown): Promise<never> {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(failure);
    return Promise.reject(failure);
  }
}

export function connectRoundBridge(
  url: string,
  options: Omit<RoundBridgeOptions, "loadBuild">,
): () => void {
  const origin = bridgeOrigin(url);
  const bridge = new OrderedRoundBridge({
    ...options,
    loadBuild: (event) => loadVerifiedBuild(origin, event),
  });
  const source = new EventSource(`${origin}/api/events`);
  source.addEventListener("open", () => options.onConnection?.(true));
  source.addEventListener("round", (message) => {
    try {
      void bridge
        .receive(JSON.parse((message as MessageEvent<string>).data))
        .catch(() => {});
    } catch (error) {
      options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  source.addEventListener("error", () => {
    options.onConnection?.(false);
    options.onError?.(new Error("Round connection lost; reconnecting"));
  });
  return () => {
    bridge.close();
    source.close();
  };
}
