import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPreflight } from "../../bench/src/preflight.js";
import { type PooledMutant, ROOT } from "../../mutator/src/gate.js";
import { TwitchHandler } from "../../twitch/src/events.js";
import { parseFixture, replayFixtures } from "../../twitch/src/fixtures.js";
import { startGameClient } from "./client.js";
import type { RoundEnvelope } from "./contracts.js";
import { RoundEngine } from "./engine.js";
import {
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
  console.log(`Local round logs: ${directory}`);
  // This exact sandbox validation makes no model call and fails before any SDK turn.
  await runPreflight(directory);
  const client = await startGameClient(join(directory, "client.log"));
  let server: Awaited<ReturnType<typeof startRoundServer>> | undefined;
  let engine: RoundEngine | undefined;
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
    ) as { mutants: PooledMutant[] };
    const mutant = pool.mutants.find((item) => item.family === "gravity-sign");
    if (!mutant) throw new Error("Fixture requires a gated gravity mutant");
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
      port: 4317,
      overlayDirectory: join(ROOT, "apps/overlay/dist"),
      install: async (artifact, signal) => {
        await client.install(artifact, signal);
      },
      record: (envelope) => {
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
    console.log(JSON.stringify(receipt, null, 2));
    if (
      result.phase !== "resolved" ||
      snapshot.broadcast.bug !== "fixed" ||
      snapshot.installs.length < 2 ||
      snapshot.installs.some((item) => !item.statePreserved)
    )
      throw new Error(
        "Local fixture round did not complete a verified hot swap",
      );
    console.log(
      `Public receipt: ${await saveReceipt(join(ROOT, "docs/rounds"), publicReceipt({ result, client: snapshot, events, breaker: viewerLabel(start.event.chatter_user_id, await viewerKey(join(ROOT, ".local"))) }))}`,
    );
    if (process.argv.includes("--serve")) {
      console.log(
        "Round complete. Press Ctrl+C to close the local overlay server.",
      );
      await new Promise<void>((done) => process.once("SIGINT", done));
    }
  } finally {
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
