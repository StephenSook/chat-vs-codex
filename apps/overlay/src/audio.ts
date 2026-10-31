import type { OverlayEvent } from "./events.js";

export const DEFAULT_VOLUME = 0.15;
export interface AudioSettings {
  muted: boolean;
  volume: number;
}
export interface AudioStatus extends AudioSettings {
  unlocked: boolean;
  blocked: boolean;
}
export interface AudioClip {
  volume: number;
  pause(): void;
  play(): Promise<void>;
  addEventListener(
    type: "ended",
    callback: () => void,
    options: { once: true },
  ): void;
}
export interface AudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const SETTINGS_KEY = "chat-vs-codex-audio";
const boundVolume = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_VOLUME;

/** Observed transitions only; no timers, delayed sounds, or synthetic game events. */
export class OverlayAudio {
  private settings: AudioSettings = { muted: false, volume: DEFAULT_VOLUME };
  private unlocked = false;
  private blocked = false;
  private roundId: string | null = null;
  private readonly played = new Set<string>();
  private readonly active = new Set<AudioClip>();
  private voice: AudioClip | null = null;
  constructor(
    private readonly options: {
      createClip: (url: string) => AudioClip;
      autoArm?: boolean;
      storage?: AudioStorage;
      onChange?: (status: AudioStatus) => void;
    },
  ) {
    try {
      const raw: unknown = JSON.parse(
        options.storage?.getItem(SETTINGS_KEY) ?? "null",
      );
      if (
        raw &&
        typeof raw === "object" &&
        "muted" in raw &&
        typeof raw.muted === "boolean" &&
        "volume" in raw &&
        typeof raw.volume === "number"
      )
        this.settings = { muted: raw.muted, volume: boundVolume(raw.volume) };
    } catch {
      /* Browser storage is optional, including in OBS. */
    }
    if (options.autoArm) {
      // OBS permits autoplay. An ordinary browser may still refuse play(),
      // which returns to the existing gesture path without queuing old sounds.
      this.settings = { muted: false, volume: DEFAULT_VOLUME };
      this.unlocked = true;
    }
  }
  snapshot(): AudioStatus {
    return { ...this.settings, unlocked: this.unlocked, blocked: this.blocked };
  }
  private changed(): void {
    this.options.onChange?.(this.snapshot());
  }
  private save(): void {
    try {
      this.options.storage?.setItem(
        SETTINGS_KEY,
        JSON.stringify(this.settings),
      );
    } catch {
      /* Storage failure must not stop play. */
    }
    this.changed();
  }
  setVolume(value: number): void {
    this.settings.volume = boundVolume(value);
    for (const clip of this.active) clip.volume = this.settings.volume;
    this.save();
  }
  setMuted(value: boolean): void {
    this.settings.muted = value;
    if (value) this.stop();
    this.save();
  }
  /** Must be called directly from a user gesture; rejected autoplay stays visibly locked. */
  async unlock(): Promise<void> {
    const clip = this.options.createClip("/audio/bug-in.wav");
    clip.volume = 0;
    try {
      await clip.play();
      clip.pause();
      this.unlocked = true;
      this.blocked = false;
      this.settings.muted = false;
      this.save();
    } catch {
      this.blocked = true;
      this.changed();
    }
  }
  observe(event: OverlayEvent): void {
    if (event.type === "round.preparing" || event.type === "round.started")
      this.roundId = event.id;
    if (!("roundId" in event) || event.roundId !== this.roundId) return;
    if (event.type === "tests.green") this.sound("codex-fix", event.roundId);
    if (
      event.type === "round.autopsy" &&
      event.autopsy.status === "rolled-back"
    )
      this.sound("codex-fail", event.roundId);
  }
  observeBuild(event: {
    roundId: string;
    phase: "broken" | "repaired" | "rollback";
  }): void {
    if (event.roundId === this.roundId && event.phase === "broken")
      this.sound("bug-in", event.roundId);
  }
  observeState(event: {
    roundId: string | null;
    phase: string;
    winner: "chat" | "codex" | null;
  }): void {
    if (event.roundId !== this.roundId || !event.roundId) return;
    if (event.winner === "chat") this.sound("chat-correct", event.roundId);
    if (event.phase === "rolled-back") this.sound("codex-fail", event.roundId);
  }
  private sound(name: string, roundId: string): void {
    this.play(`/audio/${name}.wav`, `${roundId}:${name}`);
  }
  playCommentary(url: string, id: string): void {
    // The host serves registered cache keys. No arbitrary media origin.
    let path: URL;
    try {
      path = new URL(url);
    } catch {
      return;
    }
    if (
      !/^https?:$/.test(path.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(path.hostname) ||
      path.username ||
      path.password ||
      path.search ||
      path.hash ||
      !/^\/api\/commentary\/[a-f0-9]{64}\.mp3$/.test(path.pathname)
    )
      return;
    this.play(url, `voice:${id}`, true);
  }
  private play(url: string, key: string, voice = false): void {
    if (this.played.has(key)) return;
    this.played.add(key);
    if (!this.unlocked || this.settings.muted || this.settings.volume === 0)
      return;
    if (voice && this.voice) {
      this.voice.pause();
      this.active.delete(this.voice);
    }
    const clip = this.options.createClip(url);
    clip.volume = this.settings.volume;
    this.active.add(clip);
    if (voice) this.voice = clip;
    clip.addEventListener(
      "ended",
      () => {
        this.active.delete(clip);
        if (this.voice === clip) this.voice = null;
      },
      { once: true },
    );
    void clip.play().catch(() => {
      this.active.delete(clip);
      if (this.voice === clip) this.voice = null;
      this.blocked = true;
      this.unlocked = false;
      this.changed();
    });
  }
  stop(): void {
    for (const clip of this.active) clip.pause();
    this.active.clear();
    this.voice = null;
  }
}
