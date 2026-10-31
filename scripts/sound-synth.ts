import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_RATE = 22050;
export const PCM_PEAK = 8000;
export const SOUND_NAMES = [
  "bug-in",
  "chat-correct",
  "codex-fix",
  "codex-fail",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];
const NOTES: Record<SoundName, readonly number[]> = {
  "bug-in": [440, 311, 220],
  "chat-correct": [659, 880, 1109],
  "codex-fix": [523, 659, 784, 1047],
  "codex-fail": [330, 247, 165],
};

/** Original mono 16-bit PCM. Integer phase, envelopes and seeded noise give
 * byte-identical assets without a codec, oscillator library or third-party audio. */
export function synthesize(name: SoundName): Buffer {
  const notes = NOTES[name];
  const noteFrames = 1984;
  const frames = noteFrames * notes.length;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  let noise = 0x43c0de;
  for (const [index, frequency] of notes.entries()) {
    let phase = 0;
    const increment = Math.trunc((frequency * 4294967296) / SAMPLE_RATE);
    for (let frame = 0; frame < noteFrames; frame++) {
      const p = phase >>> 16;
      const triangle = p < 32768 ? p * 2 - 32768 : 98303 - p * 2;
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      const tone =
        name === "bug-in"
          ? Math.trunc((triangle * 3 + ((noise & 65535) - 32768)) / 4)
          : triangle;
      const attack = Math.min(256, frame * 8);
      const release = Math.trunc(((noteFrames - frame - 1) * 256) / noteFrames);
      const envelope = Math.min(attack, release);
      const sample = Math.trunc((tone * PCM_PEAK * envelope) / (32768 * 256));
      wav.writeInt16LE(sample, 44 + (index * noteFrames + frame) * 2);
      phase = (phase + increment) >>> 0;
    }
  }
  return wav;
}

export async function writeSounds(root: string, check = false): Promise<void> {
  const directory = resolve(root, "apps/overlay/public/audio");
  const assets = SOUND_NAMES.map((name) => {
    const bytes = synthesize(name);
    return {
      name,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const manifest = `${JSON.stringify(
    {
      provenance:
        "Original Chat vs Codex integer synth; scripts/sound-synth.ts",
      format: "mono PCM16 WAV",
      sampleRate: SAMPLE_RATE,
      peakLimit: PCM_PEAK,
      assets: assets.map(({ name, bytes, sha256 }) => ({
        file: `${name}.wav`,
        bytes: bytes.length,
        sha256,
      })),
    },
    null,
    2,
  )}\n`;
  if (!check) await mkdir(directory, { recursive: true });
  for (const { name, bytes } of assets) {
    const path = resolve(directory, `${name}.wav`);
    if (check) {
      if (!(await readFile(path)).equals(bytes))
        throw new Error(`Sound asset differs: ${name}`);
    } else await writeFile(path, bytes);
  }
  const path = resolve(directory, "manifest.json");
  if (check) {
    if ((await readFile(path, "utf8")) !== manifest)
      throw new Error("Sound manifest differs");
  } else await writeFile(path, manifest);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await writeSounds(
    fileURLToPath(new URL("../", import.meta.url)),
    process.argv.includes("--check"),
  );
}
