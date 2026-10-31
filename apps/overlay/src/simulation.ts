import { TRACKS } from "@chat-vs-codex/replay";
import { createState, hashState, type State, step } from "@chat-vs-codex/sim";

export const FRAME_MS = 1000 / 60;
export const AUTOPILOT_HOLD_MS = 1200;
const CLEAN = TRACKS.find((track) => track.name === "clean-flag");
if (!CLEAN) throw new Error("The committed clean replay track is missing");
export const CLEAN_TRACK = CLEAN;

export interface SimulationModule {
  createState(seed?: number): State;
  step(state: State, input: number): State;
  hashState(state: State): string;
}

function assertState(state: unknown): asserts state is State {
  if (!state || typeof state !== "object")
    throw new Error("Invalid simulation state");
  const value = state as Record<string, unknown>;
  for (const key of [
    "frame",
    "x",
    "y",
    "vx",
    "vy",
    "coyote",
    "buffer",
    "jumps",
    "bufferedJumps",
    "platformLandings",
    "edgeLandings",
  ]) {
    if (!Number.isSafeInteger(value[key]))
      throw new Error(`Invalid simulation state: ${key}`);
  }
  for (const key of ["grounded", "platform", "jumpHeld", "alive", "won"]) {
    if (typeof value[key] !== "boolean")
      throw new Error(`Invalid simulation state: ${key}`);
  }
  if (
    !Array.isArray(value.rng) ||
    !value.rng.length ||
    !value.rng.every(Number.isSafeInteger)
  )
    throw new Error("Invalid simulation RNG state");
  const enemy = value.enemy as Record<string, unknown> | undefined;
  if (
    !enemy ||
    ["x", "y", "vy", "direction", "turns"].some(
      (key) => !Number.isSafeInteger(enemy[key]),
    )
  )
    throw new Error("Invalid simulation enemy state");
}

function frozenClone(state: State): State {
  const cloned = structuredClone(state);
  Object.freeze(cloned.rng);
  Object.freeze(cloned.enemy);
  return Object.freeze(cloned);
}

/** Presentation owns the clock and inputs; all physics remain in the public sim. */
export class SimulationPlayer {
  state: State;
  private accumulatedMs = 0;
  private replayIndex = 0;
  private replayHoldMs = 0;
  private module: SimulationModule = { createState, step, hashState };

  constructor(readonly mode: "replay" | "play") {
    this.state = createState(CLEAN_TRACK.seed);
  }

  reset(): void {
    this.state = this.module.createState(CLEAN_TRACK.seed);
    this.accumulatedMs = 0;
    this.replayIndex = 0;
    this.replayHoldMs = 0;
  }

  /** Validate off the live state, then replace functions without resetting any clock or state. */
  install(module: unknown): void {
    const candidate = module as Partial<SimulationModule> | null;
    if (
      !candidate ||
      typeof candidate.createState !== "function" ||
      typeof candidate.step !== "function" ||
      typeof candidate.hashState !== "function"
    )
      throw new Error("Build is missing simulation exports");
    assertState(candidate.createState(CLEAN_TRACK.seed));
    const probe = candidate.step(frozenClone(this.state), 0);
    assertState(probe);
    if (
      probe.frame !== this.state.frame &&
      probe.frame !== this.state.frame + 1
    )
      throw new Error("Build is incompatible with the live frame");
    const hash = candidate.hashState(probe);
    if (typeof hash !== "string" || !/^[0-9a-f]{8}$/i.test(hash))
      throw new Error("Build returned an invalid state hash");
    this.module = candidate as SimulationModule;
  }

  hash(): string {
    return this.module.hashState(this.state);
  }

  advance(elapsedMs: number, input = 0, autopilot = false): { deaths: number } {
    let deaths = 0;
    // Freeze on tab suspension instead of accelerating through unseen gameplay.
    this.accumulatedMs += Math.max(0, Math.min(250, elapsedMs));
    while (this.accumulatedMs + 0.000001 >= FRAME_MS) {
      this.accumulatedMs -= FRAME_MS;
      if (
        autopilot &&
        (!this.state.alive ||
          this.state.won ||
          this.replayIndex >= CLEAN_TRACK.inputs.length)
      ) {
        this.replayHoldMs += FRAME_MS;
        if (this.replayHoldMs + 0.000001 >= AUTOPILOT_HOLD_MS) {
          this.reset();
          break;
        }
        continue;
      }
      if (
        this.mode === "replay" &&
        this.replayIndex >= CLEAN_TRACK.inputs.length
      ) {
        this.replayHoldMs += FRAME_MS;
        if (this.replayHoldMs >= 2000) {
          this.reset();
          break;
        }
        continue;
      }
      const wasAlive = this.state.alive;
      const mask =
        this.mode === "replay" || autopilot
          ? (CLEAN_TRACK.inputs[this.replayIndex++] ?? 0)
          : input;
      this.state = this.module.step(this.state, mask);
      if (wasAlive && !this.state.alive) deaths++;
    }
    return { deaths };
  }
}
