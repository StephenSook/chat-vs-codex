import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RoundEvent } from "./contracts.js";

export interface CommentaryAudio {
  id: string;
  roundId: string;
  phase: "broken" | "repairing" | "fixed" | "failed";
  audioUrl: string;
}

const MAX_BYTES = 512 * 1024;
const MAX_CACHE_WRITES = 64;
const CONFIG = {
  region: "us-east-1",
  engine: "neural",
  voice: "Joanna",
  format: "mp3",
} as const;

export function commentaryLine(event: RoundEvent): {
  roundId: string;
  phase: CommentaryAudio["phase"];
  text: string;
} | null {
  if (event.type === "game.build" && event.phase === "broken")
    return {
      roundId: event.roundId,
      phase: "broken",
      text: "Something broke.",
    };
  if (
    event.type === "round.state" &&
    event.phase === "repairing" &&
    event.roundId
  )
    return { roundId: event.roundId, phase: "repairing", text: "Codex is in." };
  if (event.type === "overlay" && event.event.type === "round.autopsy") {
    const autopsy = event.event.autopsy;
    if (autopsy.status === "rolled-back")
      return {
        roundId: autopsy.roundId,
        phase: "failed",
        text: "The fix did not land.",
      };
    const ms = autopsy.durations.timeToGreenMs;
    if (ms !== null && Number.isFinite(ms) && ms >= 0)
      return {
        roundId: autopsy.roundId,
        phase: "fixed",
        text: `Fixed in ${Math.round(ms / 1000)} seconds.`,
      };
    return { roundId: autopsy.roundId, phase: "fixed", text: "Fixed." };
  }
  return null;
}

/** No AWS module import, credentials lookup, file access or logging while disabled. */
export function createCommentary(options: {
  enabled?: boolean;
  cacheDirectory: string;
  timeoutMs?: number;
  synthesize?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  report?: (message: string) => void;
}) {
  let closed = false;
  let latest: string | null = null;
  let roundId: string | null = null;
  let writes = 0;
  let phaseRank = -1;
  let revision = 0;
  let active: AbortController | undefined;
  const seen = new Set<string>();
  const audio = new Map<string, Uint8Array>();
  let pending = Promise.resolve();
  let client: import("@aws-sdk/client-polly").PollyClient | undefined;
  const synthesize =
    options.synthesize ??
    (async (text: string, signal: AbortSignal) => {
      const { PollyClient, SynthesizeSpeechCommand } = await import(
        "@aws-sdk/client-polly"
      );
      client ??= new PollyClient({ region: CONFIG.region, maxAttempts: 1 });
      const result = await client.send(
        new SynthesizeSpeechCommand({
          Engine: CONFIG.engine,
          VoiceId: CONFIG.voice,
          OutputFormat: CONFIG.format,
          TextType: "text",
          Text: text,
        }),
        { abortSignal: signal },
      );
      if (!result.AudioStream) throw new Error("No commentary audio");
      // Stream collection is bounded, including a provider that ignores ContentLength.
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of result.AudioStream as AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        length += chunk.length;
        if (length > MAX_BYTES)
          throw new Error("Commentary audio exceeds byte budget");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    });
  const enabled = options.enabled ?? process.env.POLLY_ENABLED === "1";
  return {
    observe(event: RoundEvent, emit: (event: CommentaryAudio) => void): void {
      if (!enabled || closed) return;
      if (event.type === "round.state" && event.phase === "preparing") {
        revision++;
        active?.abort();
        roundId = event.roundId;
        latest = null;
        phaseRank = -1;
        seen.clear();
        audio.clear();
      }
      const line = commentaryLine(event);
      if (!line || (roundId !== null && line.roundId !== roundId)) return;
      roundId ??= line.roundId;
      const key = `${line.roundId}:${line.phase}`;
      const rank =
        line.phase === "broken" ? 0 : line.phase === "repairing" ? 1 : 2;
      if (rank <= phaseRank) return;
      if (seen.has(key)) return;
      phaseRank = rank;
      seen.add(key);
      latest = key;
      active?.abort();
      const generation = revision;
      pending = pending
        .then(async () => {
          if (closed || latest !== key || generation !== revision) return;
          const id = createHash("sha256")
            .update(JSON.stringify({ ...CONFIG, text: line.text }))
            .digest("hex");
          const file = join(options.cacheDirectory, `${id}.mp3`);
          active = new AbortController();
          const signal = AbortSignal.any([
            active.signal,
            AbortSignal.timeout(options.timeoutMs ?? 8000),
          ]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          let temporary: string | undefined;
          try {
            const work = async () => {
              let bytes: Uint8Array | undefined;
              try {
                const handle = await open(
                  file,
                  constants.O_RDONLY | constants.O_NOFOLLOW,
                );
                try {
                  const info = await handle.stat();
                  if (
                    !info.isFile() ||
                    info.size > MAX_BYTES ||
                    info.size === 0
                  )
                    throw new Error("Invalid commentary cache");
                  const buffer = Buffer.alloc(MAX_BYTES + 1);
                  const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    0,
                  );
                  if (bytesRead === 0 || bytesRead > MAX_BYTES)
                    throw new Error("Invalid commentary cache byte count");
                  bytes = buffer.subarray(0, bytesRead);
                } finally {
                  await handle.close();
                }
              } catch {
                /* Missing or invalid cache gets regenerated with fixed text only. */
              }
              if (!bytes) {
                if (writes >= MAX_CACHE_WRITES)
                  throw new Error("Commentary cache write budget exhausted");
                bytes = await synthesize(line.text, signal);
                signal.throwIfAborted();
                if (bytes.length === 0 || bytes.length > MAX_BYTES)
                  throw new Error("Invalid commentary byte count");
                writes++;
                await mkdir(options.cacheDirectory, {
                  recursive: true,
                  mode: 0o700,
                });
                signal.throwIfAborted();
                temporary = join(
                  options.cacheDirectory,
                  `.${randomUUID()}.tmp`,
                );
                const handle = await open(temporary, "wx", 0o600);
                try {
                  await handle.writeFile(bytes);
                } finally {
                  await handle.close();
                }
                signal.throwIfAborted();
                await rename(temporary, file);
                temporary = undefined;
              }
              signal.throwIfAborted();
              if (closed || latest !== key || generation !== revision) return;
              audio.set(id, bytes);
              emit({
                id: key,
                roundId: line.roundId,
                phase: line.phase,
                audioUrl: `/api/commentary/${id}.mp3`,
              });
            };
            await Promise.race([
              work(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Commentary timeout")),
                  options.timeoutMs ?? 8000,
                );
                signal.addEventListener(
                  "abort",
                  () => reject(new Error("Commentary aborted")),
                  { once: true },
                );
              }),
            ]);
          } catch {
            if (!signal.aborted && !closed)
              options.report?.(
                "Commentary unavailable; continuing without voice.",
              );
          } finally {
            if (timer) clearTimeout(timer);
            if (temporary) await rm(temporary, { force: true }).catch(() => {});
          }
        })
        .catch(() => {});
    },
    readAudio(id: string): Uint8Array | null {
      if (!enabled || closed || !/^[a-f0-9]{64}$/.test(id)) return null;
      return audio.get(id) ?? null;
    },
    async drain(): Promise<void> {
      await pending;
    },
    async close(): Promise<void> {
      closed = true;
      active?.abort();
      client?.destroy();
      audio.clear();
      await pending;
    },
  };
}
