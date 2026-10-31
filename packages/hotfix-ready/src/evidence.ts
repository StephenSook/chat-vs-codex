export interface GateTrack {
  name: string;
  seed: number;
  inputs: number[];
}
export interface GateSample {
  frame: number;
  x: number;
  y: number;
  alive: boolean;
  won: boolean;
  stateHash: string;
}
export interface GateEvidence {
  tracks: {
    name: string;
    hashes: { frame: number; hash: string }[];
    outcome: Omit<GateSample, "stateHash">;
    samples: GateSample[];
  }[];
  canary: { frames: number; alive: boolean; won: boolean };
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid replay adapter evidence: expected object");
  return value as Record<string, unknown>;
};
function refuse(): never {
  throw new Error(
    "Invalid replay adapter evidence: incomplete or invalid frames, hashes, tracks or canary",
  );
}
export function parseGateOutput(value: unknown): {
  definitions: GateTrack[];
  evidence: GateEvidence;
} {
  const envelope = object(value);
  const definitions = envelope.definitions;
  if (
    !Array.isArray(definitions) ||
    !definitions.length ||
    definitions.length > 32
  )
    refuse();
  const names = new Set<string>();
  for (const raw of definitions) {
    const track = object(raw);
    if (
      typeof track.name !== "string" ||
      !track.name ||
      track.name.length > 80 ||
      names.has(track.name) ||
      !Number.isSafeInteger(track.seed) ||
      !Array.isArray(track.inputs) ||
      track.inputs.length !== 600 ||
      !track.inputs.every(
        (input) =>
          Number.isSafeInteger(input) && input >= 0 && input <= 0xffffffff,
      )
    )
      refuse();
    names.add(track.name);
  }
  const evidence = object(envelope.evidence);
  const tracks = evidence.tracks;
  const canary = object(evidence.canary);
  if (
    !Array.isArray(tracks) ||
    tracks.length !== definitions.length ||
    typeof canary.alive !== "boolean" ||
    typeof canary.won !== "boolean" ||
    !Number.isSafeInteger(canary.frames) ||
    Number(canary.frames) < 1 ||
    Number(canary.frames) > 1200 ||
    (canary.alive && !canary.won && canary.frames !== 1200)
  )
    refuse();
  for (let index = 0; index < tracks.length; index++) {
    const result = object(tracks[index]);
    const samples = result.samples;
    const hashes = result.hashes;
    const outcome = object(result.outcome);
    if (
      result.name !== definitions[index].name ||
      !Array.isArray(samples) ||
      samples.length !== 600 ||
      !Array.isArray(hashes) ||
      hashes.length !== 10
    )
      refuse();
    for (let frame = 1; frame <= 600; frame++) {
      const sample = object(samples[frame - 1]);
      if (
        sample.frame !== frame ||
        !Number.isSafeInteger(sample.x) ||
        !Number.isSafeInteger(sample.y) ||
        typeof sample.alive !== "boolean" ||
        typeof sample.won !== "boolean" ||
        typeof sample.stateHash !== "string" ||
        !/^[a-f0-9]{8}$/.test(sample.stateHash)
      )
        refuse();
      if (frame % 60 === 0) {
        const hash = object(hashes[frame / 60 - 1]);
        if (hash.frame !== frame || hash.hash !== sample.stateHash) refuse();
      }
    }
    const last = object(samples[599]);
    if (
      ["frame", "x", "y", "alive", "won"].some(
        (key) => outcome[key] !== last[key],
      )
    )
      refuse();
  }
  return {
    definitions: definitions as GateTrack[],
    evidence: evidence as unknown as GateEvidence,
  };
}
