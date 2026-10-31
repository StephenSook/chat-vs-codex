import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClientSnapshot } from "./client.js";
import type { RoundEnvelope } from "./contracts.js";
import type { RoundSnapshot } from "./engine.js";

export function viewerLabel(actor: string, key: Uint8Array): string {
  return `viewer-${createHmac("sha256", key).update(actor).digest("hex").slice(0, 16)}`;
}

/** The salt stays private so public labels cannot be reversed with an ID dictionary. */
export async function viewerKey(directory: string): Promise<Buffer> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "round-viewer-key");
  try {
    await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await chmod(file, 0o600);
  const key = await readFile(file);
  if (key.length !== 32) throw new Error("Invalid private viewer key");
  return key;
}

export function publicReceipt(input: {
  result: RoundSnapshot;
  client: ClientSnapshot;
  events: readonly RoundEnvelope[];
  breaker: string;
}) {
  const { result, client } = input;
  if (
    !result.roundId ||
    !/^[a-f0-9-]{36}$/.test(result.roundId) ||
    result.phase !== "resolved" ||
    (result.reason !== null && result.reason !== "round-limit") ||
    client.broadcast.bug !== "fixed" ||
    client.installs.length < 2 ||
    client.installs.some((install) => !install.statePreserved) ||
    !client.buildId ||
    client.installs.at(-1)?.buildId !== client.buildId ||
    !/^[a-f0-9]{64}$/.test(client.buildId) ||
    !/^viewer-[a-f0-9]{16}$/.test(input.breaker)
  )
    throw new Error(
      "Public receipts require a verified state-preserving round",
    );
  return {
    schemaVersion: 1,
    roundId: result.roundId,
    mode: "local-fixture",
    fixture: "bare-break-then-wrong-enum-hint",
    model: "gpt-6.1-terra",
    effort: "low",
    breaker: input.breaker,
    family: client.broadcast.bugName,
    winner: result.winner,
    reason: result.reason,
    scores: { chat: result.scores.chat, codex: result.scores.codex },
    clock: "host-monotonic-ms",
    durations: result.durations ?? null,
    timingDefinition:
      "Time to green starts immediately before the SDK call and ends after verified build installation; head start is separate. Repair ends at submitted patch verification after the SDK turn.",
    events: input.events.map(({ sequence, event, atMs, wallTime }) => ({
      sequence,
      type: event.type === "overlay" ? event.event.type : event.type,
      ...(event.type === "round.state" || event.type === "game.build"
        ? { phase: event.phase }
        : {}),
      atMs: event.atMs ?? atMs ?? null,
      wallTime: event.wallTime ?? wallTime ?? null,
    })),
    verification: {
      fullReplaySuite: true,
      heldOutReplay: true,
      statePreserved: true,
      finalStateHash: client.hash,
      builds: client.installs.map(({ buildId, frame, statePreserved }) => ({
        digest: buildId,
        frame,
        statePreserved,
      })),
    },
  };
}

export async function saveReceipt(
  directory: string,
  receipt: ReturnType<typeof publicReceipt>,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${receipt.roundId}.json`);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeFile(file, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(file, "utf8")) !== bytes)
      throw new Error("Refusing to overwrite a different round receipt");
  }
  return file;
}
