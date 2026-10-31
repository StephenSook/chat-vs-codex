import {
  createState,
  hashState,
  INPUT,
  Q,
  type State,
  step,
} from "./src/index.js";
import { HELD_OUT, TRACKS, type Track } from "./tracks.js";

export { HELD_OUT, TRACKS } from "./tracks.js";
export function runTrack(track: Track): {
  hashes: { frame: number; hash: string }[];
  outcome: {
    frame: number;
    x: number;
    y: number;
    alive: boolean;
    won: boolean;
  };
  samples: {
    frame: number;
    x: number;
    y: number;
    alive: boolean;
    won: boolean;
    stateHash: string;
  }[];
} {
  if (!track.inputs.length || track.inputs.length > 3600)
    throw new Error("Frame budget exceeded");
  let state = createState(track.seed);
  const hashes = [];
  const samples = [];
  for (const input of track.inputs) {
    state = step(state, input);
    if (
      ![state.x, state.y, state.vx, state.vy, state.paddle, state.frame].every(
        Number.isSafeInteger,
      )
    )
      throw new Error("Noninteger state");
    if (state.frame % 60 === 0)
      hashes.push({ frame: state.frame, hash: hashState(state) });
    samples.push({
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
      stateHash: hashState(state),
    });
  }
  return {
    hashes,
    outcome: {
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
    },
    samples,
  };
}
export function canary(): { frames: number; alive: boolean; won: boolean } {
  let state: State = createState(13);
  // Bot follows the ball using the same input interface as a player, launching immediately.
  for (let frame = 0; frame < 1200; frame++) {
    const delta = state.x - state.paddle;
    state = step(
      state,
      (frame === 0 ? INPUT.LAUNCH : 0) |
        (delta > 3 * Q ? INPUT.RIGHT : delta < -3 * Q ? INPUT.LEFT : 0),
    );
    if (!state.alive || state.won)
      return { frames: frame + 1, alive: state.alive, won: state.won };
  }
  return { frames: 1200, alive: state.alive, won: state.won };
}
export function gateEvidence(): unknown {
  return {
    tracks: TRACKS.map((track) => ({ name: track.name, ...runTrack(track) })),
    canary: canary(),
  };
}
export function heldOutGolden(): unknown {
  const { hashes, outcome } = runTrack(HELD_OUT);
  return { hashes, outcome };
}
