import type { RegressionRecord } from "../../../packages/bench/src/regressions.js";
import type { ValidatedReplayFrame } from "../../../packages/bench/src/validated-replay.js";
import type { Track } from "../../../packages/replay/src/index.js";
import type { EnemyState } from "../../../packages/sim/src/index.js";
import type { ComparisonEvidence, JudgeEvidence, Receipt } from "./evidence.js";
import { type GameModule, proofAvailability, sha256 } from "./proof.js";

export interface ComparisonFrame extends ValidatedReplayFrame {
  enemy: EnemyState;
}

export function comparisonAvailability(
  round: JudgeEvidence["rounds"][number],
  replay: JudgeEvidence["replay"],
): string | null {
  const proof = proofAvailability(round.receipt, replay.buildDigest);
  if (proof) return proof;
  const comparison = round.comparison;
  if (!comparison) return "No original-build comparison evidence was recorded.";
  if (comparison.status === "unavailable") return comparison.reason;
  if (
    !round.regression ||
    comparison.fixedBuildDigest !== replay.buildDigest ||
    comparison.brokenBuildDigest !==
      round.receipt.verification.builds[0]?.digest ||
    comparison.regressionPath !== round.regression.path ||
    comparison.regressionDigest !== round.regression.digest
  )
    return "Comparison artifacts do not match the round's committed evidence.";
  return null;
}

/** Every displayed point comes from the same input frame in two exact artifacts.
 * Keep the held-out receipt MATCH separate from this recorded regression route.
 */
export async function replayComparison(
  brokenGame: GameModule,
  fixedGame: GameModule,
  comparison: Extract<ComparisonEvidence, { status: "available" }>,
  regression: RegressionRecord,
  receipt: Receipt,
): Promise<{
  broken: ComparisonFrame[];
  fixed: ComparisonFrame[];
  trackDigest: string;
  brokenFramesDigest: string;
  firstDivergence: number;
  fixedFramesDigest?: string;
  visibleFrame?: number;
}> {
  const installed = receipt.verification.builds;
  if (
    regression.schemaVersion !== 1 ||
    regression.roundId !== receipt.roundId ||
    regression.viewer !== receipt.breaker ||
    installed.length !== 2 ||
    installed.some((build) => !build.statePreserved) ||
    comparison.brokenBuildDigest !== installed[0]?.digest ||
    comparison.fixedBuildDigest !== installed[1]?.digest ||
    comparison.fixedBuildDigest !== receipt.validationReplay?.buildDigest
  )
    throw new Error(
      "Comparison source installations or round identity do not match",
    );
  const mutation = regression.mutation;
  if (
    regression.mutantId !== mutation.id ||
    (await sha256(
      JSON.stringify([
        regression.sourceDigest,
        mutation.file,
        mutation.location,
        mutation.original,
        mutation.replacement,
      ]),
    )) !== regression.mutationFingerprint
  )
    throw new Error("Comparison mutation fingerprint mismatch");
  if (
    receipt.mutation &&
    (receipt.mutation.sourceDigest !== regression.sourceDigest ||
      receipt.mutation.candidateDigest !==
        (await sha256(
          JSON.stringify([
            mutation.id,
            mutation.file,
            mutation.site,
            mutation.mutator,
            mutation.location,
            mutation.original,
            mutation.replacement,
          ]),
        )))
  )
    throw new Error("Comparison mutation does not match receipt");
  const route = regression.routes[comparison.routeIndex];
  if (
    !Number.isSafeInteger(comparison.routeIndex) ||
    !route ||
    route.firstDivergence === null ||
    !route.track.inputs.length ||
    route.track.inputs.length > 3600 ||
    !Number.isSafeInteger(route.track.seed) ||
    route.track.inputs.some(
      (input) => !Number.isSafeInteger(input) || input < 0 || input > 7,
    ) ||
    route.buggy.samples.length !== route.track.inputs.length
  )
    throw new Error("Invalid comparison replay frame budget");
  if ((await sha256(JSON.stringify(route.buggy))) !== route.buggyTraceDigest)
    throw new Error("Comparison recorded trace digest mismatch");
  const broken = comparisonFrames(brokenGame, route.track);
  const fixed = comparisonFrames(fixedGame, route.track);
  const projection = (frame: ComparisonFrame): ValidatedReplayFrame => ({
    frame: frame.frame,
    x: frame.x,
    y: frame.y,
    alive: frame.alive,
    won: frame.won,
    stateHash: frame.stateHash,
  });
  if (
    JSON.stringify(broken.map(projection)) !==
    JSON.stringify(route.buggy.samples)
  )
    throw new Error(
      "Original re-simulation does not match the recorded broken trace",
    );
  const checkpoints = fixed
    .filter((frame) => frame.frame % 60 === 0)
    .map((frame) => ({ frame: frame.frame, hash: frame.stateHash }));
  const last = fixed.at(-1);
  if (
    !last ||
    JSON.stringify(checkpoints) !== JSON.stringify(route.expected.hashes) ||
    JSON.stringify({
      frame: last.frame,
      x: last.x,
      y: last.y,
      alive: last.alive,
      won: last.won,
    }) !== JSON.stringify(route.expected.outcome) ||
    route.expected.checkpoints.some(
      (checkpoint) =>
        fixed[checkpoint.frame - 1]?.stateHash !== checkpoint.hash,
    )
  )
    throw new Error(
      "Repaired re-simulation does not match recorded regression checkpoints",
    );
  const firstDivergence = fixed.find(
    (frame, index) => frame.stateHash !== broken[index]?.stateHash,
  )?.frame;
  if (firstDivergence !== route.firstDivergence)
    throw new Error("Comparison first divergence differs from recorded trace");
  const display = comparison.display;
  const displayBroken = comparisonFrames(brokenGame, display.track);
  const displayFixed = comparisonFrames(fixedGame, display.track);
  const trackDigest = await sha256(JSON.stringify(display.track));
  const brokenFramesDigest = await sha256(JSON.stringify(displayBroken));
  const fixedFramesDigest = await sha256(JSON.stringify(displayFixed));
  const displayFirstDivergence = displayFixed.find(
    (frame, index) => frame.stateHash !== displayBroken[index]?.stateHash,
  )?.frame;
  const visibleFrame = comparisonVisibleFrame(
    fixedGame,
    displayBroken,
    displayFixed,
  );
  if (
    trackDigest !== display.trackDigest ||
    brokenFramesDigest !== display.brokenFramesDigest ||
    fixedFramesDigest !== display.fixedFramesDigest ||
    displayFirstDivergence === undefined ||
    displayFirstDivergence !== display.firstDivergence ||
    visibleFrame === null ||
    visibleFrame !== display.visibleFrame
  )
    throw new Error(
      "Display replay track, frame digests or visible witness do not match",
    );
  return {
    broken: displayBroken,
    fixed: displayFixed,
    trackDigest,
    brokenFramesDigest,
    fixedFramesDigest,
    firstDivergence: displayFirstDivergence,
    visibleFrame,
  };
}

/** Bound pure replay used by the build producer and independently by the browser. */
export function comparisonFrames(
  game: GameModule,
  track: Track,
): ComparisonFrame[] {
  if (
    !track ||
    !Number.isSafeInteger(track.seed) ||
    !Array.isArray(track.inputs) ||
    !track.inputs.length ||
    track.inputs.length > 3600 ||
    track.inputs.some(
      (input) => !Number.isSafeInteger(input) || input < 0 || input > 7,
    )
  )
    throw new Error("Invalid display replay frame budget");
  let state = game.createState(track.seed);
  return track.inputs.map((input, index) => {
    state = game.step(state, input);
    if (
      state.frame !== index + 1 ||
      ![state.x, state.y, ...Object.values(state.enemy)].every(
        Number.isSafeInteger,
      )
    )
      throw new Error("Invalid re-simulated comparison state");
    return {
      frame: state.frame,
      x: state.x,
      y: state.y,
      alive: state.alive,
      won: state.won,
      stateHash: game.hashState(state),
      enemy: { ...state.enemy },
    };
  });
}

/** Hash differences alone are not a visible glitch. Use actual 32 px separation
 * of player/enemy positions, or a different player survival state, within 10 s.
 */
export function comparisonVisibleFrame(
  game: GameModule,
  broken: readonly ComparisonFrame[],
  fixed: readonly ComparisonFrame[],
): number | null {
  const distance = 32 * game.UNIT;
  const separated = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) =>
    (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) > distance * distance;
  return (
    fixed.find((frame, index) => {
      const original = broken[index];
      return (
        frame.frame <= 600 &&
        original &&
        (original.alive !== frame.alive ||
          separated(original, frame) ||
          separated(original.enemy, frame.enemy))
      );
    })?.frame ?? null
  );
}
