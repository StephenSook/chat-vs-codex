import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPreflight } from "../../bench/src/preflight.js";
import {
  eligibleMutants,
  loadRegressions,
} from "../../bench/src/regressions.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { TwitchHandler } from "../../twitch/src/events.js";
import { parseFixture, replayFixtures } from "../../twitch/src/fixtures.js";
import { ROUND_PORT } from "./address.js";
import { startGameClient } from "./client.js";
import { createCommentary } from "./commentary.js";
import type { RoundEnvelope } from "./contracts.js";
import { RoundEngine } from "./engine.js";
import { startPitWall } from "./pit-wall.js";
import {
  loadPreviousVerifiedRound,
  publicReceipt,
  saveReceipt,
  viewerKey,
  viewerLabel,
} from "./receipt.js";
import { createRoundRuntime } from "./runtime.js";
import { startRoundServer } from "./server.js";

async function main() {
  if (!process.argv.includes("--run")) {
    console.log(
      "One local fixture round: gpt-6.1-terra low, real 15 s chat head start, 60 s race, 240 s repair backstop. No Twitch messages or rewards. Add --run to execute; --serve keeps the overlay available afterward.",
    );
    return;
  }
  const directory = join(ROOT, ".local/round-runs", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await viewerKey(join(ROOT, ".local"));
  const previousRound = await loadPreviousVerifiedRound(
    join(ROOT, "docs/rounds"),
  );
  console.log(`Local round logs: ${directory}`);
  // This exact sandbox validation makes no model call and fails before any SDK turn.
  await runPreflight(directory);
  const client = await startGameClient(join(directory, "client.log"));
  let server: Awaited<ReturnType<typeof startRoundServer>> | undefined;
  let engine: RoundEngine | undefined;
  let pitWall: Awaited<ReturnType<typeof startPitWall>> | undefined;
  let guessTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveries: Promise<unknown>[] = [];
  const events: RoundEnvelope[] = [];
  const deliveryErrors: unknown[] = [];
  let guessSent = false;
  let fixtureSent = false;
  try {
    await client.snapshot();
    const pool = JSON.parse(
      await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
    ) as { sourceDigest: string; mutants: PooledMutant[] };
    const mutant = eligibleMutants(
      pool.mutants,
      pool.sourceDigest,
      await loadRegressions(),
    ).find((item) => item.family === "gravity-sign");
    if (!mutant)
      throw new Error("Fixture requires an unlearned gated gravity mutant");
    const raw = JSON.parse(
      await readFile(
        join(ROOT, "packages/twitch/fixtures/session.json"),
        "utf8",
      ),
    ) as unknown[];
    const start = parseFixture(raw[0]);
    if (start.type !== "channel.chat.message")
      throw new Error("Fixture must start with chat");
    const guess = {
      type: start.type,
      event: {
        ...start.event,
        message_id: "fixture-round-guess",
        message: {
          text: "!guess swapped-controls",
          fragments: [
            { type: "text" as const, text: "!guess swapped-controls" },
          ],
        },
      },
    };
    const handler = new TwitchHandler({
      broadcasterId: start.event.broadcaster_user_id,
      sink: {
        public: (intent) => engine?.handlePublic(intent),
        private: (intent) => {
          engine?.handlePrivate(intent);
        },
      },
    });
    server = await startRoundServer({
      ...(process.env.PIT_WALL === "1"
        ? {
            death: (roundId: string, id: string) => pitWall?.death(roundId, id),
          }
        : {}),
      commentary: createCommentary({
        cacheDirectory: join(ROOT, ".local/polly"),
        report: (message) => console.log(message),
      }),
      port: ROUND_PORT,
      overlayDirectory: join(ROOT, "apps/overlay/dist"),
      install: async (artifact, signal) => {
        await client.install(artifact, signal);
      },
      record: (envelope) => {
        pitWall?.publish(envelope);
        events.push(envelope);
        deliveries.push(
          appendFile(
            join(directory, "events.jsonl"),
            `${JSON.stringify(envelope)}\n`,
          ),
        );
        deliveries.push(
          client.event(envelope).catch((error: unknown) => {
            deliveryErrors.push(error);
            void engine?.stop().catch(() => {});
          }),
        );
        if (
          envelope.event.type === "round.state" &&
          envelope.event.phase === "head-start" &&
          !fixtureSent
        ) {
          fixtureSent = true;
          guessTimer = setTimeout(() => {
            guessSent = true;
            replayFixtures([guess], handler);
          }, 1000);
        }
      },
    });
    engine = new RoundEngine({
      identify: (actor) => viewerLabel(actor, key),
      previousRound,
      runtime: createRoundRuntime({
        runsDirectory: directory,
        fixtureMutantId: mutant.id,
      }),
      publish: server.publish,
      activate: server.activate,
    });
    console.log(
      `Overlay: ${server.origin}/?bridge=${encodeURIComponent(server.origin)}`,
    );
    if (process.env.PIT_WALL === "1")
      pitWall = await startPitWall({
        action: (action) =>
          engine?.streamerAction(action) ?? {
            accepted: false,
            reason: "runner-unavailable",
          },
        record: (entry) =>
          deliveries.push(
            appendFile(
              join(directory, "pit-wall.jsonl"),
              `${JSON.stringify(entry)}\n`,
              { mode: 0o600 },
            ),
          ),
        announce: (message) => console.log(message),
      });
    replayFixtures([start], handler);
    const result = await engine.waitForRound();
    if (guessTimer) clearTimeout(guessTimer);
    await Promise.all(deliveries);
    if (deliveryErrors.length)
      throw new Error("Game client event delivery failed");
    const snapshot = await client.snapshot();
    const receipt = {
      fixture: "bare-break-then-wrong-enum-hint",
      model: "gpt-6.1-terra",
      effort: "low",
      headStartMs: 15000,
      guessSent,
      result,
      client: snapshot,
    };
    await writeFile(
      join(directory, "result.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    const { ghost, ...broadcast } = snapshot.broadcast;
    console.log(
      JSON.stringify(
        {
          ...receipt,
          client: {
            ...snapshot,
            broadcast: {
              ...broadcast,
              ghost: ghost
                ? {
                    frameCount: ghost.frames.length,
                    sourceDigest: ghost.sourceDigest,
                    trackDigest: ghost.trackDigest,
                  }
                : null,
            },
          },
        },
        null,
        2,
      ),
    );
    if (
      result.phase !== "resolved" ||
      snapshot.broadcast.bug !== "fixed" ||
      snapshot.installs.length < 2 ||
      snapshot.installs.some((item) => !item.statePreserved) ||
      ghost === null ||
      !result.autopsy?.regressionTest
    )
      throw new Error(
        "Local fixture round did not complete a verified hot swap",
      );
    console.log(
      `Public receipt: ${await saveReceipt(join(ROOT, "docs/rounds"), publicReceipt({ result, client: snapshot, events, breaker: viewerLabel(start.event.chatter_user_id, key) }))}`,
    );
    if (process.argv.includes("--serve")) {
      console.log(
        "Round complete. Press Ctrl+C to close the local overlay server.",
      );
      await new Promise<void>((done) => process.once("SIGINT", done));
    }
  } finally {
    await pitWall?.close();
    if (guessTimer) clearTimeout(guessTimer);
    await engine?.stop();
    await server?.close();
    await client.close();
  }
}

main().catch(() => {
  console.error(
    "Local fixture round failed. See the printed private log directory. No retry was attempted.",
  );
  process.exitCode = 1;
});
