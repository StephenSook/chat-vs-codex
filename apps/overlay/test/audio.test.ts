import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PCM_PEAK,
  SAMPLE_RATE,
  SOUND_NAMES,
  synthesize,
  writeSounds,
} from "../../../scripts/sound-synth.js";
import { type AudioClip, DEFAULT_VOLUME, OverlayAudio } from "../src/audio.js";

function setup(autoArm = false) {
  const clips: { url: string; clip: AudioClip; end: () => void }[] = [];
  const createClip = vi.fn((url: string) => {
    const row = {
      url,
      end: () => {},
      clip: {
        volume: 1,
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        addEventListener: vi.fn((_type: "ended", end: () => void) => {
          row.end = end;
        }),
      },
    };
    clips.push(row);
    return row.clip;
  });
  const audio = new OverlayAudio({ createClip, autoArm });
  const start = (id = "r1") =>
    audio.observe({ type: "round.started", id, number: 1, atMs: 0 });
  return { audio, clips, createClip, start };
}

describe("original sound assets", () => {
  it("reproduces every committed WAV and manifest byte for byte", async () => {
    await writeSounds(
      fileURLToPath(new URL("../../../", import.meta.url)),
      true,
    );
  });
  it("uses four distinct short mono PCM clips with a bounded peak and silent seams", () => {
    const rendered = SOUND_NAMES.map(synthesize);
    expect(
      new Set(rendered.map((bytes) => bytes.toString("base64"))).size,
    ).toBe(4);
    expect(
      rendered.reduce((total, bytes) => total + bytes.length, 0),
    ).toBeLessThan(200000);
    for (const bytes of rendered) {
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 16)).toBe("WAVEfmt ");
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(SAMPLE_RATE);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(bytes.length / 2 / SAMPLE_RATE).toBeLessThan(0.5);
      let peak = 0;
      for (let index = 44; index < bytes.length; index += 2)
        peak = Math.max(peak, Math.abs(bytes.readInt16LE(index)));
      expect(peak).toBeGreaterThan(1000);
      expect(peak).toBeLessThanOrEqual(PCM_PEAK);
      expect(bytes.readInt16LE(44)).toBe(0);
      expect(bytes.readInt16LE(bytes.length - 2)).toBe(0);
    }
  });
});

describe("observed overlay audio", () => {
  it("arms OBS without a click, stays silent until an actual event and keeps mute controls", async () => {
    const { audio, clips, start } = setup(true);
    expect(audio.snapshot()).toEqual({
      muted: false,
      volume: DEFAULT_VOLUME,
      unlocked: true,
      blocked: false,
    });
    expect(clips).toHaveLength(0);
    start();
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    expect(clips).toHaveLength(1);
    expect(clips[0]?.url).toBe("/audio/bug-in.wav");
    expect(clips[0]?.clip.volume).toBe(DEFAULT_VOLUME);
    audio.setMuted(true);
    expect(clips[0]?.clip.pause).toHaveBeenCalledOnce();
    audio.observe({ type: "tests.green", roundId: "r1" });
    expect(clips).toHaveLength(1);
    audio.setMuted(false);
    audio.setVolume(0.1);
    start("r2");
    audio.observeBuild({ roundId: "r2", phase: "broken" });
    expect(clips[1]?.clip.volume).toBe(0.1);
  });
  it("starts explicitly armed audio at the safe default even with loud stored preferences", () => {
    const audio = new OverlayAudio({
      autoArm: true,
      createClip: vi.fn(),
      storage: {
        getItem: () => JSON.stringify({ muted: true, volume: 1 }),
        setItem: vi.fn(),
      },
    });
    expect(audio.snapshot()).toMatchObject({
      volume: DEFAULT_VOLUME,
      muted: false,
      unlocked: true,
    });
  });
  it("falls back to gesture recovery if a browser refuses an armed clip without replaying it", async () => {
    const { audio, clips, createClip, start } = setup(true);
    start();
    const rejected = {
      volume: 1,
      play: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
      pause: vi.fn(),
      addEventListener: vi.fn(),
    };
    createClip.mockReturnValueOnce(rejected);
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    await Promise.resolve();
    expect(audio.snapshot()).toMatchObject({ blocked: true, unlocked: false });
    await audio.unlock();
    expect(audio.snapshot()).toMatchObject({ blocked: false, unlocked: true });
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    expect(rejected.play).toHaveBeenCalledOnce();
    expect(clips).toHaveLength(1); // Only the gesture's silent unlock probe.
  });
  it("stays silent before a user gesture and never queues old events", async () => {
    const { audio, clips, start } = setup();
    expect(audio.snapshot()).toEqual({
      muted: false,
      volume: DEFAULT_VOLUME,
      unlocked: false,
      blocked: false,
    });
    start();
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    expect(clips).toHaveLength(0);
    await audio.unlock();
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    expect(clips).toHaveLength(1); // The gesture's zero-volume unlock only.
    expect(clips[0]?.clip.volume).toBe(0);
    start("r2");
    audio.observeBuild({ roundId: "r2", phase: "broken" });
    expect(clips[1]?.url).toBe("/audio/bug-in.wav");
  });
  it("plays each actual build, correct winner, verified green and rollback once", async () => {
    const { audio, clips, start } = setup();
    await audio.unlock();
    start();
    audio.observeBuild({ roundId: "old", phase: "broken" });
    audio.observe({
      type: "codex.step",
      roundId: "r1",
      id: "test",
      step: { kind: "tests" },
      status: "done",
      attempt: 1,
      total: 1,
    });
    audio.observe({ type: "bug.named", roundId: "r1", name: "gravity-sign" });
    expect(clips).toHaveLength(1);
    for (let n = 0; n < 2; n++) {
      audio.observeBuild({ roundId: "r1", phase: "broken" });
      audio.observeState({ roundId: "r1", phase: "repairing", winner: "chat" });
      audio.observeBuild({ roundId: "r1", phase: "repaired" });
      audio.observe({ type: "tests.green", roundId: "r1" });
    }
    expect(clips.slice(1).map(({ url }) => url)).toEqual([
      "/audio/bug-in.wav",
      "/audio/chat-correct.wav",
      "/audio/codex-fix.wav",
    ]);
    start("r2");
    audio.observeState({ roundId: "r2", phase: "rolled-back", winner: null });
    audio.observeState({ roundId: "r2", phase: "rolled-back", winner: null });
    expect(clips.at(-1)?.url).toBe("/audio/codex-fail.wav");
    expect(clips).toHaveLength(5);
  });
  it("clamps volume, updates playing clips and stops them on mute", async () => {
    const { audio, clips, start } = setup();
    await audio.unlock();
    start();
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    const playing = clips.at(-1)?.clip;
    expect(playing?.volume).toBe(DEFAULT_VOLUME);
    audio.setVolume(5);
    expect(playing?.volume).toBe(1);
    audio.setVolume(-4);
    expect(audio.snapshot().volume).toBe(0);
    audio.setVolume(Number.NaN);
    expect(audio.snapshot().volume).toBe(DEFAULT_VOLUME);
    audio.setMuted(true);
    expect(playing?.pause).toHaveBeenCalledOnce();
    audio.observeState({ roundId: "r1", phase: "repairing", winner: "chat" });
    expect(clips).toHaveLength(2);
    audio.setMuted(false);
    audio.observeState({ roundId: "r1", phase: "repairing", winner: "chat" });
    expect(clips).toHaveLength(2); // Muted events never replay later.
  });
  it("shares mute and volume with bounded cached commentary, without voice overlap", async () => {
    const { audio, clips } = setup();
    await audio.unlock();
    audio.setVolume(0.2);
    const url = `http://127.0.0.1:8777/api/commentary/${"a".repeat(64)}.mp3`;
    audio.playCommentary("https://example.com/voice.mp3", "bad");
    audio.playCommentary(`${url}?secret=ignored`, "bad2");
    audio.playCommentary(url, "phase1");
    audio.playCommentary(url, "phase1");
    expect(clips).toHaveLength(2);
    expect(clips[1]?.clip.volume).toBe(0.2);
    audio.playCommentary(url, "phase2");
    expect(clips[1]?.clip.pause).toHaveBeenCalledOnce();
    clips[2]?.end();
    audio.stop();
    expect(clips[2]?.clip.pause).not.toHaveBeenCalled();
    audio.setMuted(true);
    audio.playCommentary(url, "phase3");
    expect(clips).toHaveLength(3);
  });
  it("shows blocked playback and tolerates unavailable storage", async () => {
    const onChange = vi.fn();
    const audio = new OverlayAudio({
      createClip: () => ({
        volume: 1,
        pause() {},
        play: async () => {
          throw new Error("Autoplay denied");
        },
        addEventListener() {},
      }),
      storage: {
        getItem() {
          throw new Error("No storage");
        },
        setItem() {
          throw new Error("No storage");
        },
      },
      onChange,
    });
    await audio.unlock();
    audio.setMuted(true);
    audio.setVolume(0.1);
    expect(audio.snapshot()).toEqual({
      volume: 0.1,
      muted: true,
      blocked: true,
      unlocked: false,
    });
    expect(onChange).toHaveBeenCalled();
  });
  it("loads bounded preferences and persists later changes", () => {
    const stored = new Map<string, string>([
      ["chat-vs-codex-audio", '{"muted":true,"volume":8}'],
    ]);
    const audio = new OverlayAudio({
      createClip: setup().createClip,
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          stored.set(key, value);
        },
      },
    });
    expect(audio.snapshot().muted).toBe(true);
    expect(audio.snapshot().volume).toBe(1);
    audio.setMuted(false);
    audio.setVolume(0.12);
    expect(JSON.parse(stored.get("chat-vs-codex-audio") ?? "null")).toEqual({
      muted: false,
      volume: 0.12,
    });
  });
  it("handles later autoplay refusal without inventing a successful playback", async () => {
    const { audio, createClip, start } = setup();
    await audio.unlock();
    start();
    createClip.mockImplementationOnce(() => ({
      volume: 1,
      pause: vi.fn(),
      play: vi.fn(async () => {
        throw new Error("Playback denied");
      }),
      addEventListener: vi.fn(),
    }));
    audio.observeBuild({ roundId: "r1", phase: "broken" });
    await Promise.resolve();
    expect(audio.snapshot().blocked).toBe(true);
    expect(audio.snapshot().unlocked).toBe(false);
  });
});
