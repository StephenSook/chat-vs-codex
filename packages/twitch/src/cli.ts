import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginAuthorization,
  createAuth,
  finishAuthorization,
  readToken,
  requireClientId,
} from "./auth.js";
import { TwitchHandler } from "./events.js";
import { createEventSub } from "./eventsub.js";
import { createRecorder, replayFixtures } from "./fixtures.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pendingPath = resolve(root, ".local/twitch-device.json");
const [command, argument, recordPath] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "auth") {
    const clientId = requireClientId();
    if (argument === "start") {
      if (existsSync(pendingPath))
        throw new Error(
          "A pending authorization already exists. Resume it or remove the expired pending file before starting again.",
        );
      const info = await beginAuthorization(clientId, pendingPath);
      process.stdout.write(
        `Authorize Twitch: ${info.verificationUri}\nUser code: ${info.userCode}\nExpires in ${info.expiresIn} seconds.\nAfter approval: pnpm --filter @chat-vs-codex/twitch auth resume\n`,
      );
      return;
    }
    if (argument !== "resume")
      throw new Error("Use auth start or auth resume.");
    await finishAuthorization(pendingPath, clientId);
    process.stdout.write(
      "Twitch authorization saved with mode 0600. No listener started.\n",
    );
    return;
  }
  if (command === "replay") {
    if (!argument)
      throw new Error("Provide a Twitch fixture JSON or JSONL path.");
    const contents = readFileSync(argument, "utf8");
    const values: unknown[] = contents.trimStart().startsWith("[")
      ? (JSON.parse(contents) as unknown[])
      : contents
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown);
    const first = values[0] as
      | {
          event?: {
            broadcaster_user_id?: string;
            to_user_id?: string;
            to_broadcaster_user_id?: string;
          };
        }
      | undefined;
    const broadcasterId =
      first?.event?.broadcaster_user_id ??
      first?.event?.to_user_id ??
      first?.event?.to_broadcaster_user_id;
    if (!broadcasterId)
      throw new Error("The first fixture must identify its broadcaster.");
    const handler = new TwitchHandler({
      broadcasterId,
      breakRewardId: "fixture-reward",
      chaosPowerUpId: "fixture-chaos",
      sink: {
        public: (intent) =>
          process.stdout.write(
            `${JSON.stringify({ fixtureIntent: intent })}\n`,
          ),
        private: () =>
          process.stdout.write(
            "Private fixture selection received (content withheld).\n",
          ),
      },
    });
    replayFixtures(values, handler);
    return;
  }
  if (command === "listen") {
    const stored = readToken();
    if (stored.clientId !== requireClientId())
      throw new Error("Stored authorization belongs to another Client ID.");
    const handler = new TwitchHandler({
      broadcasterId: stored.userId,
      sink: {
        public: (intent) =>
          process.stdout.write(`${JSON.stringify({ intent })}\n`),
        private: () =>
          process.stdout.write(
            "Private selection received. Round adapter is not attached.\n",
          ),
      },
    });
    const listener = createEventSub({
      auth: createAuth(stored),
      broadcasterId: stored.userId,
      handler,
      ...(argument === "--record" && recordPath
        ? {
            record: createRecorder(recordPath, randomBytes(32).toString("hex")),
          }
        : {}),
      status: (state) => process.stdout.write(`EventSub ${state}\n`),
    });
    process.stdout.write(
      "Listening for Twitch intents. This command does not run a game round or send chat.\n",
    );
    listener.start();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        listener.stop();
      });
    return;
  }
  throw new Error(
    "Use auth start, auth resume, listen, or replay <fixture-path>.",
  );
}
main().catch((error: unknown) => {
  // Twurple errors can contain request URLs and OAuth response bodies. Never print them.
  const safe =
    error instanceof Error &&
    !error.message.includes("\n") &&
    /^(Set TWITCH|Use |A pending |Invalid |Twitch device |Twitch authorization |Twitch device token |Provide |The first fixture |Stored authorization )/.test(
      error.message,
    )
      ? error.message
      : "Twitch operation failed. Credentials and remote response details were withheld.";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
