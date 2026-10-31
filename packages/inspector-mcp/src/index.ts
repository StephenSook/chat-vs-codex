/** Immutable telemetry only. No simulation, filesystem paths, or source execution. */
export const MAX_WINDOW = 30;
export const MAX_TRACK_FRAMES = 3600;
export const PLAYER_FIELDS = [
  "x",
  "y",
  "vx",
  "vy",
  "grounded",
  "platform",
  "coyote",
  "buffer",
  "jumpHeld",
  "alive",
  "won",
  "jumps",
  "bufferedJumps",
  "platformLandings",
  "edgeLandings",
] as const;
export const ENEMY_FIELDS = ["x", "y", "vy", "direction", "turns"] as const;
type Scalar = number | boolean;
export interface TelemetryFrame {
  frame: number;
  input: number | null;
  player: Record<(typeof PLAYER_FIELDS)[number], Scalar>;
  enemy: Record<(typeof ENEMY_FIELDS)[number], number>;
}
export interface InspectorTrack {
  name: string;
  golden: TelemetryFrame[];
  buggy: TelemetryFrame[];
}
export interface InspectorData {
  schemaVersion: 1;
  fps: 60;
  units: "Q8";
  tracks: InspectorTrack[];
}

export function telemetryFrame(
  state: {
    frame: number;
    enemy: Record<(typeof ENEMY_FIELDS)[number], number>;
  } & Record<(typeof PLAYER_FIELDS)[number], Scalar>,
  input: number | null,
): TelemetryFrame {
  return {
    frame: state.frame,
    input,
    player: Object.fromEntries(
      PLAYER_FIELDS.map((key) => [key, state[key]]),
    ) as TelemetryFrame["player"],
    enemy: Object.fromEntries(
      ENEMY_FIELDS.map((key) => [key, state.enemy[key]]),
    ) as TelemetryFrame["enemy"],
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join() === [...keys].sort().join();
}
function scalar(value: unknown): value is Scalar {
  return (
    typeof value === "boolean" ||
    (Number.isSafeInteger(value) && Math.abs(Number(value)) <= 1_000_000_000)
  );
}
const BOOLEANS = new Set(["grounded", "platform", "jumpHeld", "alive", "won"]);
function validFrame(value: unknown, index: number): value is TelemetryFrame {
  if (
    !object(value) ||
    !exact(value, ["frame", "input", "player", "enemy"]) ||
    value.frame !== index ||
    (index === 0
      ? value.input !== null
      : !Number.isInteger(value.input) ||
        Number(value.input) < 0 ||
        Number(value.input) > 7) ||
    !object(value.player) ||
    !object(value.enemy) ||
    !exact(value.player, PLAYER_FIELDS) ||
    !exact(value.enemy, ENEMY_FIELDS)
  )
    return false;
  const player = value.player;
  const enemy = value.enemy;
  return (
    PLAYER_FIELDS.every(
      (key) =>
        scalar(player[key]) &&
        (BOOLEANS.has(key)
          ? typeof player[key] === "boolean"
          : typeof player[key] === "number"),
    ) &&
    ENEMY_FIELDS.every(
      (key) => typeof enemy[key] === "number" && scalar(enemy[key]),
    )
  );
}

/** Whitelist every field before exposing data, including fixture contents. */
export function parseInspectorData(value: unknown): InspectorData {
  if (
    !object(value) ||
    !exact(value, ["schemaVersion", "fps", "units", "tracks"]) ||
    value.schemaVersion !== 1 ||
    value.fps !== 60 ||
    value.units !== "Q8" ||
    !Array.isArray(value.tracks) ||
    value.tracks.length < 1 ||
    value.tracks.length > 16
  )
    throw new Error("Invalid Inspector telemetry");
  const names = new Set<string>();
  for (const track of value.tracks) {
    if (
      !object(track) ||
      !exact(track, ["name", "golden", "buggy"]) ||
      typeof track.name !== "string" ||
      !/^replay-\d{2}$/.test(track.name) ||
      names.has(track.name) ||
      !Array.isArray(track.golden) ||
      !Array.isArray(track.buggy) ||
      track.golden.length < 2 ||
      track.golden.length > MAX_TRACK_FRAMES + 1 ||
      track.golden.length !== track.buggy.length ||
      !track.golden.every(validFrame) ||
      !track.buggy.every(validFrame)
    )
      throw new Error("Invalid Inspector track");
    const golden = track.golden as TelemetryFrame[];
    if (
      !track.buggy.every(
        (frame, index) =>
          (frame as TelemetryFrame).input === golden[index]?.input,
      )
    )
      throw new Error("Inspector inputs differ");
    names.add(track.name);
  }
  return structuredClone(value) as unknown as InspectorData;
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const trackSchema = { type: "string", pattern: "^replay-[0-9]{2}$" };
const frameSchema = { type: "integer", minimum: 0, maximum: MAX_TRACK_FRAMES };
export const TOOLS = [
  {
    name: "replay_frames",
    description:
      "Original buggy visible replay telemetry, Q8 positions/velocities, at 60 Hz. Inclusive window of at most 30 recorded frames.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["track", "from", "to"],
      properties: { track: trackSchema, from: frameSchema, to: frameSchema },
    },
    annotations,
  },
  {
    name: "first_divergence",
    description:
      "First recorded visible replay frame whose player or enemy fields differ from golden telemetry. Also lists available neutral replay names.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["track"],
      properties: { track: trackSchema },
    },
    annotations,
  },
  {
    name: "diff_telemetry",
    description:
      "Golden and original buggy player/enemy telemetry at one visible replay frame, Q8 units. Data never changes after a source edit.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["track", "frame"],
      properties: { track: trackSchema, frame: frameSchema },
    },
    annotations,
  },
] as const;

function differences(
  golden: TelemetryFrame,
  buggy: TelemetryFrame,
): Record<string, { golden: Scalar; buggy: Scalar }> {
  const result: Record<string, { golden: Scalar; buggy: Scalar }> = {};
  for (const group of ["player", "enemy"] as const) {
    for (const key of Object.keys(golden[group])) {
      const clean = (golden[group] as Record<string, Scalar>)[key];
      const broken = (buggy[group] as Record<string, Scalar>)[key];
      if (clean !== undefined && broken !== undefined && clean !== broken)
        result[`${group}.${key}`] = { golden: clean, buggy: broken };
    }
  }
  return result;
}

export function callTool(
  data: InspectorData,
  name: unknown,
  args: unknown,
): { content: { type: "text"; text: string }[]; isError: boolean } {
  const respond = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError,
  });
  if (!object(args) || !TOOLS.some((tool) => tool.name === name))
    return respond({ error: "Unknown tool or invalid arguments" }, true);
  const required =
    name === "replay_frames"
      ? ["track", "from", "to"]
      : name === "diff_telemetry"
        ? ["track", "frame"]
        : ["track"];
  if (!exact(args, required))
    return respond({ error: "Arguments must match the tool schema" }, true);
  const track = data.tracks.find((item) => item.name === args.track);
  if (!track)
    return respond(
      {
        error: "Unknown visible track",
        tracks: data.tracks.map((item) => item.name),
      },
      true,
    );
  const metadata = {
    track: track.name,
    recording: "original-buggy",
    fps: data.fps,
    units: data.units,
  };
  if (name === "first_divergence") {
    for (let index = 0; index < track.golden.length; index++) {
      const golden = track.golden[index];
      const buggy = track.buggy[index];
      if (!golden || !buggy) continue;
      const fields = differences(golden, buggy);
      if (Object.keys(fields).length)
        return respond({ ...metadata, frame: index, fields });
    }
    return respond({ ...metadata, frame: null, fields: {} });
  }
  const from = name === "diff_telemetry" ? args.frame : args.from;
  const to = name === "diff_telemetry" ? args.frame : args.to;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    Number(from) < 0 ||
    Number(to) >= track.golden.length ||
    Number(to) < Number(from) ||
    Number(to) - Number(from) >= MAX_WINDOW
  )
    return respond(
      {
        error: "Frame range must be recorded, ordered and at most 30 frames",
        lastFrame: track.golden.length - 1,
      },
      true,
    );
  if (name === "replay_frames")
    return respond({
      ...metadata,
      frames: track.buggy.slice(Number(from), Number(to) + 1),
    });
  const golden = track.golden[Number(from)];
  const buggy = track.buggy[Number(from)];
  if (!golden || !buggy) return respond({ error: "Frame unavailable" }, true);
  return respond({
    ...metadata,
    frame: from,
    golden,
    buggy,
    fields: differences(golden, buggy),
  });
}
