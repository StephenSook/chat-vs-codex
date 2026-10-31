import { TRACKS } from "@chat-vs-codex/replay";
import { createState, type State, step } from "@chat-vs-codex/sim";

export const FRAME_MS = 1000 / 60;
const CLEAN = TRACKS.find((track) => track.name === "clean-flag");
if (!CLEAN) throw new Error("The committed clean replay track is missing");
export const CLEAN_TRACK = CLEAN;

/** Presentation owns the clock and inputs; all physics remain in the public sim. */
export class SimulationPlayer {
  state: State;
  private accumulatedMs = 0;
  private replayIndex = 0;
  private replayHoldMs = 0;

  constructor(readonly mode: "replay" | "play") {
    this.state = createState(CLEAN_TRACK.seed);
  }

  reset(): void {
    this.state = createState(CLEAN_TRACK.seed);
    this.accumulatedMs = 0;
    this.replayIndex = 0;
    this.replayHoldMs = 0;
  }

  advance(elapsedMs: number, input = 0): { deaths: number } {
    let deaths = 0;
    // Freeze on tab suspension instead of accelerating through unseen gameplay.
    this.accumulatedMs += Math.max(0, Math.min(250, elapsedMs));
    while (this.accumulatedMs + 0.000001 >= FRAME_MS) {
      this.accumulatedMs -= FRAME_MS;
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
        this.mode === "replay"
          ? (CLEAN_TRACK.inputs[this.replayIndex++] ?? 0)
          : input;
      this.state = step(this.state, mask);
      if (wasAlive && !this.state.alive) deaths++;
    }
    return { deaths };
  }
}
