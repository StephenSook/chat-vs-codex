import type {
  RoundEnvelope,
  RoundEvent,
} from "../../../packages/round/src/contracts.js";
import type { OverlayEvent, OverlayEventBus } from "./events.js";
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
  onConnection?: (connected: boolean) => void;
}

/** Serializes asynchronous imports with event publication, including SSE replay after reconnect. */
export class OrderedRoundBridge {
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private roundId: string | null = null;
  private readonly seenRounds = new Set<string>();
  private faultRound: string | null = null;
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
      event.type === "overlay" && event.event.type === "round.started"
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
    }
    const receivedRoundId = this.roundId;
    const task = async () => {
      if (this.closed) return;
      const roundId =
        event.type === "overlay"
          ? event.event.type === "round.started"
            ? event.event.id
            : "roundId" in event.event
              ? event.event.roundId
              : receivedRoundId
          : event.roundId;
      if (roundId !== null && roundId !== this.roundId) return;
      if (this.faultRound !== null && roundId === this.faultRound) return;
      try {
        if (event.type === "game.build") {
          const module = await this.options.loadBuild(event);
          if (this.closed || event.roundId !== this.roundId) return;
          this.options.simulation.install(module);
        } else if (event.type === "overlay") {
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
        } else this.options.onState?.(event);
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
