import {
  createState,
  hashState,
  INPUT,
  type State,
  step,
} from "@chat-vs-codex/sim";
export const MAX_FRAMES = 3600;
export interface Track {
  name: string;
  seed: number;
  inputs: number[];
}
export interface Sample {
  frame: number;
  x: number;
  y: number;
  alive: boolean;
  won: boolean;
}
export interface ReplayResult {
  hashes: { frame: number; hash: string }[];
  outcome: Sample;
  samples: Sample[];
  final: State;
}

/** Hand-authored runs: counts are frames, masks are LEFT=1, RIGHT=2, JUMP=4. */
export function expand(
  ...runs: readonly (readonly [number, number])[]
): number[] {
  return runs.flatMap(([frames, input]) => {
    if (!Number.isSafeInteger(frames) || frames < 0)
      throw new Error("Invalid frame count");
    return Array<number>(frames).fill(input);
  });
}
const R = INPUT.RIGHT;
const J = INPUT.JUMP;
export const TRACKS: Track[] = [
  {
    name: "clean-flag",
    seed: 13,
    inputs: expand([40, R], [1, R | J], [41, R], [1, R | J], [517, R]),
  },
  {
    name: "buffered-landing",
    seed: 13,
    inputs: expand([40, R], [1, R | J], [37, R], [1, R | J], [521, R]),
  },
  {
    name: "moving-edge",
    seed: 13,
    inputs: expand(
      [40, R],
      [1, R | J],
      [40, R],
      [1, R | J],
      [48, R],
      [1, R | J],
      [469, R],
    ),
  },
];
export const CANARY: Track = {
  name: "canary",
  seed: 31,
  inputs: expand([1, R | J], [4, R], [1195, 0]),
};
export const HELD_OUT: Track = {
  name: "held-out-delayed-start",
  seed: 97,
  inputs: expand([17, 0], [40, R], [1, R | J], [40, R], [1, R | J], [501, R]),
};

/** Frame count is bounded here; callers execute unknown code in a killable worker too. */
export function runTrack(
  track: Track,
  stepFn: typeof step = step,
): ReplayResult {
  if (track.inputs.length === 0 || track.inputs.length > MAX_FRAMES) {
    throw new Error(`Track exceeds frame budget: ${track.inputs.length}`);
  }
  let state = createState(track.seed);
  const hashes: ReplayResult["hashes"] = [];
  const samples: Sample[] = [];
  for (const input of track.inputs) {
    if (!Number.isSafeInteger(input) || input < 0 || input > 7)
      throw new Error("Invalid input mask");
    state = stepFn(state, input);
    if (![state.x, state.y, state.vx, state.vy].every(Number.isSafeInteger)) {
      throw new Error(`Non-integer state at frame ${state.frame}`);
    }
    samples.push({
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
    });
    if (state.frame % 60 === 0)
      hashes.push({ frame: state.frame, hash: hashState(state) });
  }
  const outcome = samples.at(-1);
  if (!outcome) throw new Error("Replay produced no samples");
  return { hashes, outcome, samples, final: state };
}
export function goldenResult(
  track: Track,
): Pick<ReplayResult, "hashes" | "outcome"> {
  const { hashes, outcome } = runTrack(track);
  return { hashes, outcome };
}
