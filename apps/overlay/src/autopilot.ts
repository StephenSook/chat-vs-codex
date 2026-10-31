import type { SimulationPlayer } from "./simulation.js";

export const AUTOPILOT_IDLE_MS = 3000;

/** Real canonical inputs take over only after an idle stretch, never a held key. */
export class IdleAutopilot {
  private idleMs = 0;
  active = false;

  takeOver(): void {
    this.idleMs = 0;
    this.active = false;
  }

  advance(
    simulation: SimulationPlayer,
    elapsedMs: number,
    input: number,
  ): { deaths: number } {
    if (simulation.mode !== "play") return simulation.advance(elapsedMs, input);
    if (input !== 0) this.takeOver();
    else if (!this.active) {
      // Match the game's suspension clamp: a hidden tab cannot skip the wait.
      this.idleMs += Math.max(0, Math.min(250, elapsedMs));
      if (this.idleMs + 0.000001 >= AUTOPILOT_IDLE_MS) {
        this.active = true;
        // The canonical route is authored from spawn, not an arbitrary idle spot.
        simulation.reset();
      }
    }
    return simulation.advance(elapsedMs, input, this.active);
  }
}
