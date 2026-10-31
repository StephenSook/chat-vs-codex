import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ClientSnapshot } from "./client.js";
import type { PreviousVerifiedRound, RoundEnvelope } from "./contracts.js";
import type { RoundSnapshot } from "./engine.js";

export const ROUND_TIMING_DEFINITION =
  "Time to green starts immediately before the SDK call and ends after verified build installation; head start is separate. Repair ends at submitted patch verification after the SDK turn.";

/** Select the last verified round, including legacy rounds with unavailable timing. */
export async function loadPreviousVerifiedRound(
  directory: string,
  trigger?: "broadcaster-test",
): Promise<PreviousVerifiedRound | null> {
  const files = await readdir(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const candidates: { baseline: PreviousVerifiedRound; completed: number }[] =
    [];
  for (const name of files
    .filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))
    .sort()) {
    const file = join(directory, name);
    const row = JSON.parse(await readFile(file, "utf8"));
    if (row.schemaVersion !== 1 || row.roundId !== name.slice(0, -5))
      throw new Error(`Invalid prior round receipt: ${name}`);
    const testRound =
      row.trigger === "broadcaster-test" ||
      row.autopsy?.trigger === "broadcaster-test" ||
      (Array.isArray(row.events) &&
        row.events.some(
          (event: { trigger?: unknown }) =>
            event.trigger === "broadcaster-test",
        ));
    if (testRound !== (trigger === "broadcaster-test")) continue;
    if (
      row.verification?.fullReplaySuite !== true ||
      row.verification?.heldOutReplay !== true ||
      row.verification?.statePreserved !== true ||
      (row.reason !== undefined &&
        row.reason !== null &&
        row.reason !== "round-limit")
    )
      continue;
    const resolved = Array.isArray(row.events)
      ? [...row.events]
          .reverse()
          .find(
            (event: Record<string, unknown>) =>
              event.type === "round.state" && event.phase === "resolved",
          )
      : undefined;
    const recordedTime = row.completedAt ?? resolved?.wallTime;
    // Old receipts may lack ISO completion evidence; file metadata only orders
    // that compatibility case. Absolute monotonic clocks never cross processes.
    const completed =
      recordedTime === undefined
        ? (await stat(file)).mtimeMs
        : Date.parse(recordedTime);
    if (!Number.isFinite(completed))
      throw new Error(`Invalid prior completion time: ${name}`);
    const measured = row.durations?.timeToGreenMs;
    const compatible =
      row.clock === "host-monotonic-ms" &&
      (row.timingVersion === 1 ||
        row.timingDefinition === ROUND_TIMING_DEFINITION) &&
      row.model === "gpt-6.1-terra" &&
      row.effort === "low";
    candidates.push({
      completed,
      baseline: {
        roundId: row.roundId,
        timeToGreenMs:
          compatible &&
          typeof measured === "number" &&
          Number.isFinite(measured) &&
          measured >= 0
            ? measured
            : null,
      },
    });
  }
  candidates.sort(
    (a, b) =>
      b.completed - a.completed ||
      b.baseline.roundId.localeCompare(a.baseline.roundId),
  );
  return candidates[0]?.baseline ?? null;
}

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
  mode?: "local-fixture" | "live-twitch";
}) {
  const { result, client } = input;
  const autopsy = result.autopsy ?? null;
  // Any retained test marker taints the entire receipt, even if another producer
  // accidentally omitted it on the terminal state. Never publish it as a viewer run.
  const provenance =
    result.trigger === "broadcaster-test" ||
    autopsy?.trigger === "broadcaster-test" ||
    input.events.some(
      ({ event, trigger }) =>
        trigger === "broadcaster-test" || event.trigger === "broadcaster-test",
    )
      ? { trigger: "broadcaster-test" as const }
      : {};
  const lastGhost = [...input.events]
    .reverse()
    .find(
      ({ event }) =>
        event.type === "overlay" &&
        event.event.type === "round.ghost" &&
        event.event.roundId === result.roundId,
    )?.event;
  const replay =
    lastGhost?.type === "overlay" && lastGhost.event.type === "round.ghost"
      ? lastGhost.event.replay
      : null;
  if (
    replay &&
    !input.events.some(
      ({ event }) =>
        event.type === "game.build" &&
        event.phase === "repaired" &&
        event.roundId === result.roundId &&
        event.digest === client.buildId &&
        event.sourceDigest === replay.sourceDigest,
    )
  )
    throw new Error("Validated replay is not bound to the installed repair");
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
    !/^viewer-[a-f0-9]{16}$/.test(input.breaker) ||
    (autopsy !== null &&
      (autopsy.status !== "verified" ||
        autopsy.roundId !== result.roundId ||
        (autopsy.breaker !== null &&
          !/^viewer-[a-f0-9]{16}$/.test(autopsy.breaker)) ||
        (autopsy.firstCorrectGuesser !== null &&
          !/^viewer-[a-f0-9]{16}$/.test(autopsy.firstCorrectGuesser)) ||
        (autopsy.regressionTest !== null &&
          (autopsy.breaker === null ||
            autopsy.regressionError !== null ||
            autopsy.regressionTest.path !==
              `chat-found/${result.roundId}.json` ||
            !/^[a-f0-9]{64}$/.test(autopsy.regressionTest.digest))) ||
        (autopsy.regressionError !== null &&
          !["regression-write-failed", "regression-timeout"].includes(
            autopsy.regressionError,
          ))))
  )
    throw new Error(
      "Public receipts require a verified state-preserving round",
    );
  return {
    schemaVersion: 1,
    roundId: result.roundId,
    ...provenance,
    mode: input.mode ?? "local-fixture",
    ...(input.mode === "live-twitch"
      ? {}
      : { fixture: "bare-break-then-wrong-enum-hint" }),
    model: "gpt-6.1-terra",
    effort: "low",
    breaker: input.breaker,
    firstCorrectGuesser: autopsy?.firstCorrectGuesser ?? null,
    validationReplay:
      replay === null
        ? null
        : {
            sourceDigest: replay.sourceDigest,
            trackDigest: replay.trackDigest,
            buildDigest: client.buildId,
            frameCount: replay.frames.length,
            framesDigest: createHash("sha256")
              .update(JSON.stringify(replay.frames))
              .digest("hex"),
          },
    autopsy:
      autopsy === null
        ? null
        : {
            roundId: autopsy.roundId,
            ...provenance,
            status: autopsy.status,
            reason: autopsy.reason,
            breaker: autopsy.breaker,
            firstCorrectGuesser: autopsy.firstCorrectGuesser,
            family: autopsy.family,
            winner: autopsy.winner,
            patch:
              autopsy.patch === null
                ? null
                : {
                    added: autopsy.patch.added,
                    removed: autopsy.patch.removed,
                    preview: [...autopsy.patch.preview],
                  },
            explanation: autopsy.explanation,
            ...(autopsy.headline === undefined
              ? {}
              : { headline: autopsy.headline }),
            durations: { ...autopsy.durations },
            previousRoundId: autopsy.previousRoundId,
            deltaMs: autopsy.deltaMs,
            regressionTest:
              autopsy.regressionTest === null
                ? null
                : {
                    path: autopsy.regressionTest.path,
                    digest: autopsy.regressionTest.digest,
                  },
            regressionError: autopsy.regressionError,
          },
    family: client.broadcast.bugName,
    winner: result.winner,
    reason: result.reason,
    scores: { chat: result.scores.chat, codex: result.scores.codex },
    clock: "host-monotonic-ms",
    timingVersion: 1,
    durations: result.durations ?? null,
    timingDefinition: ROUND_TIMING_DEFINITION,
    completedAt:
      [...input.events]
        .reverse()
        .find(
          ({ event }) =>
            event.type === "round.state" && event.phase === "resolved",
        )?.wallTime ?? new Date().toISOString(),
    events: input.events.map(({ sequence, event, atMs, wallTime }) => ({
      sequence,
      ...provenance,
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
