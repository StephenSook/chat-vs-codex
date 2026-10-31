/** Observable replay telemetry only. Never accept labels, source, locations or clean frames. */
export interface TriageFrame {
  frame: number;
  input: number | null;
  x: number;
  y: number;
  vx: number;
  /** Velocity of the controllable paddle in Breakout; runner vx otherwise. */
  responseVx?: number;
  vy: number;
  alive: boolean;
  contact: boolean;
  enemyTurns: number;
}
export const FEATURE_NAMES = [
  "horizontalSignChanges",
  "verticalSignChanges",
  "contactFrames",
  "contactTransitions",
  "inputResponseLag",
  "oppositeInputFrames",
  "upwardFrames",
  "downwardFrames",
  "enemyTurnFrames",
  "deadFrames",
  "meanAbsVx",
  "meanAbsVy",
  "horizontalSpan",
  "verticalSpan",
] as const;
export function replayFeatures(
  tracks: readonly (readonly TriageFrame[])[],
): number[] {
  if (!tracks.length || tracks.length > 32)
    throw new Error("Missing bounded telemetry tracks");
  const vectors = tracks.map((frames) => {
    if (frames.length < 2 || frames.length > 3601)
      throw new Error("Invalid telemetry frame budget");
    const values = Array<number>(FEATURE_NAMES.length).fill(0);
    let lag = 0;
    let waiting = false;
    let desired = 0;
    const xs: number[] = [];
    const ys: number[] = [];
    frames.forEach((row, index) => {
      if (
        ![row.frame, row.x, row.y, row.vx, row.vy, row.enemyTurns].every(
          Number.isFinite,
        ) ||
        (index > 0 && row.frame !== (frames[index - 1]?.frame ?? -2) + 1)
      )
        throw new Error("Invalid replay telemetry");
      xs.push(row.x);
      ys.push(row.y);
      const previous = frames[index - 1];
      if (!previous) return;
      if (row.vx * previous.vx < 0) values[0] = (values[0] ?? 0) + 1;
      if (row.vy * previous.vy < 0) values[1] = (values[1] ?? 0) + 1;
      values[2] = (values[2] ?? 0) + Number(row.contact);
      values[3] = (values[3] ?? 0) + Number(row.contact !== previous.contact);
      const direction =
        Number(Boolean((row.input ?? 0) & 2)) -
        Number(Boolean((row.input ?? 0) & 1));
      const previousDirection =
        Number(Boolean((previous.input ?? 0) & 2)) -
        Number(Boolean((previous.input ?? 0) & 1));
      if (direction && direction !== previousDirection) {
        waiting = true;
        desired = direction;
        lag = 0;
      }
      if (waiting) {
        if (Math.sign(row.responseVx ?? row.vx) === desired || !direction) {
          values[4] = (values[4] ?? 0) + lag;
          waiting = false;
        } else {
          lag++;
          if (index === frames.length - 1) values[4] = (values[4] ?? 0) + lag;
        }
      }
      values[5] =
        (values[5] ?? 0) + Number(direction * (row.responseVx ?? row.vx) < 0);
      values[6] = (values[6] ?? 0) + Number(row.vy < 0);
      values[7] = (values[7] ?? 0) + Number(row.vy > 0);
      values[8] =
        (values[8] ?? 0) + Number(row.enemyTurns !== previous.enemyTurns);
      values[9] = (values[9] ?? 0) + Number(!row.alive);
      values[10] = (values[10] ?? 0) + Math.abs(row.vx) / 256;
      values[11] = (values[11] ?? 0) + Math.abs(row.vy) / 256;
    });
    values[10] = (values[10] ?? 0) / (frames.length - 1);
    values[11] = (values[11] ?? 0) / (frames.length - 1);
    values[12] = (Math.max(...xs) - Math.min(...xs)) / 256;
    values[13] = (Math.max(...ys) - Math.min(...ys)) / 256;
    return values;
  });
  return FEATURE_NAMES.map(
    (_, i) =>
      vectors.reduce((sum, vector) => sum + (vector[i] ?? 0), 0) /
      vectors.length,
  );
}
