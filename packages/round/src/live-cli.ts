import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "../../bench/src/preflight.js";
import { ROOT } from "../../mutator/src/gate.js";
import {
  createAuth,
  REAUTHORIZE,
  readToken,
  requireClientId,
  SCOPES,
  type StoredToken,
} from "../../twitch/src/auth.js";
import { createEventSub } from "../../twitch/src/eventsub.js";
import { createLiveHelix } from "../../twitch/src/helix.js";
import { createLiveRewards } from "../../twitch/src/rewards.js";
import { ROUND_PORT } from "./address.js";
import { startGameClient } from "./client.js";
import { eventStamp } from "./clocks.js";
import { createCommentary } from "./commentary.js";
import type { RoundEnvelope } from "./contracts.js";
import { RoundEngine, type RoundSnapshot } from "./engine.js";
import { type LiveEngine, LiveRoundController } from "./live.js";
import {
  loadPreviousVerifiedRound,
  publicReceipt,
  saveReceipt,
  viewerKey,
  viewerLabel,
} from "./receipt.js";
import { createRoundRuntime } from "./runtime.js";
import { startRoundServer } from "./server.js";

export function parseLiveArguments(args: readonly string[]): {
  dryChat: boolean;
  allowBroadcasterTest: boolean;
  help: boolean;
} {
  if (
    args.some(
      (arg) =>
        !["--dry-chat", "--help", "--allow-broadcaster-test"].includes(arg),
    )
  )
    throw new Error(
      "Use pnpm round:live [--dry-chat] [--allow-broadcaster-test].",
    );
  return {
    dryChat: args.includes("--dry-chat"),
    allowBroadcasterTest: args.includes("--allow-broadcaster-test"),
    help: args.includes("--help"),
  };
}

/** A fresh provider token must still belong to the intended broadcaster and app. */
export async function verifyLiveAuthorization(options: {
  stored: Pick<StoredToken, "clientId" | "userId">;
  clientId: string;
  accessToken(): Promise<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{
  login: "steve_sociall";
  userId: string;
  scopes: string[];
  expiresIn: number;
}> {
  if (options.stored.clientId !== options.clientId)
    throw new Error(
      "Stored Twitch authorization belongs to another Client ID.",
    );
  try {
    const token = await options.accessToken();
    if (!token) throw new Error("missing token");
    const response = await (options.fetch ?? fetch)(
      "https://id.twitch.tv/oauth2/validate",
      {
        headers: { Authorization: `OAuth ${token}` },
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
    );
    const data: unknown = await response.json();
    if (!response.ok || !data || typeof data !== "object")
      throw new Error("invalid validation");
    const row = data as Record<string, unknown>;
    if (
      row.client_id !== options.clientId ||
      row.user_id !== options.stored.userId ||
      row.login !== "steve_sociall" ||
      typeof row.expires_in !== "number" ||
      !Number.isFinite(row.expires_in) ||
      row.expires_in <= 0 ||
      !Array.isArray(row.scopes) ||
      row.scopes.length !== SCOPES.length ||
      new Set(row.scopes).size !== SCOPES.length ||
      !SCOPES.every((scope) => (row.scopes as unknown[]).includes(scope))
    )
      throw new Error("unexpected authorization");
    return {
      login: "steve_sociall",
      userId: options.stored.userId,
      scopes: [...row.scopes] as string[],
      expiresIn: row.expires_in,
    };
  } catch {
    // OAuth failures can contain credentials. Never forward their remote bodies.
    throw new Error(
      `Twitch validation failed: require steve_sociall, this Client ID, and exactly the 11 requested scopes. ${REAUTHORIZE}`,
    );
  }
}

/** Keep the next round out until this round's private result and public receipt settle. */
export function createLiveRoundGate(
  engine: Pick<
    RoundEngine,
    "snapshot" | "handlePublic" | "handlePrivate" | "waitForRound"
  >,
  complete: (result: RoundSnapshot) => Promise<void>,
  failed: (error: unknown) => void,
): { adapter: LiveEngine; drain(): Promise<void> } {
  let settling = false;
  let pending = Promise.resolve();
  const begin = (operation: () => void) => {
    if (settling || engine.snapshot().active) return;
    settling = true;
    try {
      operation();
    } catch (error) {
      settling = false;
      failed(error);
      return;
    }
    if (!engine.snapshot().active) {
      settling = false;
      return;
    }
    pending = engine
      .waitForRound()
      .then(complete)
      .catch(failed)
      .finally(() => {
        settling = false;
      });
  };
  return {
    adapter: {
      snapshot: () => ({ active: settling || engine.snapshot().active }),
      handlePublic: (intent) => {
        if (intent.kind === "break-requested")
          begin(() => engine.handlePublic(intent));
        else engine.handlePublic(intent);
      },
      handlePrivate: (intent) =>
        begin(() => {
          engine.handlePrivate(intent);
        }),
    },
    drain: () => pending,
  };
}

/** One failed cleanup must not leave an EventSub socket or sandboxed child running. */
export async function closeLiveResources(
  operations: readonly (() => unknown | Promise<unknown>)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new Error(
      "Live session cleanup failed; remaining cleanup operations were attempted.",
    );
}

export async function runLiveCli(
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const flags = parseLiveArguments(args);
  if (flags.allowBroadcasterTest)
    console.warn(
      "WARNING: BROADCASTER TEST MODE. Broadcaster !break and enum !guess are accepted. ALL rounds in this session are labelled broadcaster-test, never viewer rounds. Bot replies remain ignored.",
    );
  if (flags.help) {
    console.log(
      "pnpm round:live [--dry-chat] [--allow-broadcaster-test]: listen on steve_sociall, including while offline. Another viewer sends !break or whispers one enum family. Only commands start Codex; --dry-chat logs replies and skips markers, clips and pins. The explicit test flag also accepts broadcaster chat commands and labels all session rounds broadcaster-test.",
    );
    return;
  }
  const directory = join(ROOT, ".local/round-runs", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  console.log(`Live round private logs: ${directory}`);
  if (
    !(
      await stat(join(ROOT, "apps/overlay/dist/index.html")).catch(() => null)
    )?.isFile()
  )
    throw new Error("Build the overlay before starting round:live.");
  signal.throwIfAborted();
  // Real clean validation under the same profile, with workspace .tmp, before any listener or SDK turn.
  await runPreflight(directory);
  signal.throwIfAborted();
  const stored = readToken(); // Enforces a regular 0600 file inside .local/.
  const clientId = requireClientId();
  if (stored.clientId !== clientId)
    throw new Error(
      "Stored Twitch authorization belongs to another Client ID.",
    );
  const auth = createAuth(stored, undefined, { signal });
  auth.onRefresh((_userId, token) =>
    console.log(
      `Twitch token refreshed: length ${token.accessToken.length}; expires in ${token.expiresIn ?? "unknown"} s.`,
    ),
  );
  const accessToken = async () => {
    const value = await auth.getAccessTokenForUser(stored.userId, [...SCOPES]);
    if (!value?.accessToken) throw new Error("Twitch token is unavailable.");
    return value.accessToken;
  };
  const account = await verifyLiveAuthorization({
    stored,
    clientId,
    accessToken,
    signal,
  });
  console.log(
    `Twitch login: ${account.login}; expires in ${account.expiresIn} s; scopes: ${account.scopes.join(", ")}`,
  );
  const key = await viewerKey(join(ROOT, ".local"));
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let failure: unknown;
  const fatal = (error: unknown) => {
    failure ??= error;
    abort.abort();
  };
  auth.onRefreshFailure((_userId, error) => fatal(error));
  let writes = Promise.resolve();
  let deliveries = Promise.resolve();
  const record = (entry: Record<string, unknown>) => {
    writes = writes
      .then(() =>
        appendFile(
          join(directory, "twitch.jsonl"),
          `${JSON.stringify({ ...eventStamp(), ...entry })}\n`,
          { mode: 0o600 },
        ),
      )
      .catch(fatal);
  };
  let client: Awaited<ReturnType<typeof startGameClient>> | undefined;
  let server: Awaited<ReturnType<typeof startRoundServer>> | undefined;
  let listener: ReturnType<typeof createEventSub> | undefined;
  let engine: RoundEngine | undefined;
  let gate: ReturnType<typeof createLiveRoundGate> | undefined;
  let controller: LiveRoundController | undefined;
  let events: RoundEnvelope[] = [];
  try {
    const rewards = createLiveRewards({
      clientId,
      broadcasterId: account.userId,
      accessToken,
      record: (entry) => {
        record(entry);
        // Reward endpoints return no credentials. The adapter redacts reflected tokens.
        if (entry.type === "twitch.reward-response")
          console.log(`Twitch reward response: ${JSON.stringify(entry)}`);
        else if (
          entry.type === "twitch.reward-ready" ||
          entry.type === "twitch.reward-unavailable"
        )
          console.log(`Twitch rewards: ${JSON.stringify(entry)}`);
      },
    });
    const reward = await rewards.setup({ dryRun: flags.dryChat });
    client = await startGameClient(join(directory, "client.log"));
    const runningClient = client;
    await client.snapshot();
    abort.signal.throwIfAborted();
    controller = new LiveRoundController({
      broadcasterId: account.userId,
      botUserId: account.userId,
      identify: (actor) => viewerLabel(actor, key),
      record,
      publish: (event) => server?.publish(event),
      dryChat: flags.dryChat,
      allowBroadcasterTest: flags.allowBroadcasterTest,
      ...(reward ? { rewards: { api: rewards, capability: reward } } : {}),
      helix: createLiveHelix({
        clientId,
        broadcasterId: account.userId,
        senderId: account.userId,
        accessToken,
        record,
      }),
    });
    const live = controller;
    server = await startRoundServer({
      commentary: createCommentary({
        cacheDirectory: join(ROOT, ".local/polly"),
        report: (message) => console.log(message),
      }),
      session: {
        mode: "live-twitch",
        ...(flags.allowBroadcasterTest
          ? { trigger: "broadcaster-test" as const }
          : {}),
      },
      port: ROUND_PORT,
      overlayDirectory: join(ROOT, "apps/overlay/dist"),
      install: async (artifact, installSignal) => {
        await runningClient.install(artifact, installSignal);
      },
      present: (event) => live.present(event),
      record: (envelope) => {
        if (
          envelope.event.type === "round.state" &&
          envelope.event.phase === "preparing"
        )
          events = [];
        events.push(envelope);
        writes = writes
          .then(() =>
            appendFile(
              join(directory, "events.jsonl"),
              `${JSON.stringify(envelope)}\n`,
              { mode: 0o600 },
            ),
          )
          .catch(fatal);
        deliveries = deliveries
          .then(async () => {
            await runningClient.event(envelope);
          })
          .catch(fatal);
        live.observe(envelope.event);
      },
    });
    engine = new RoundEngine({
      ...(flags.allowBroadcasterTest
        ? { trigger: "broadcaster-test" as const }
        : {}),
      identify: (actor) => viewerLabel(actor, key),
      previousRound: await loadPreviousVerifiedRound(
        join(ROOT, "docs/rounds"),
        flags.allowBroadcasterTest ? "broadcaster-test" : undefined,
      ),
      runtime: createRoundRuntime({ runsDirectory: directory }),
      publish: server.publish,
      activate: server.activate,
    });
    gate = createLiveRoundGate(
      engine,
      async (result) => {
        await deliveries;
        if (failure) throw failure;
        const snapshot = await runningClient.snapshot();
        await writeFile(
          join(directory, `${result.roundId}.json`),
          `${JSON.stringify({ mode: "live-twitch", result, client: snapshot }, null, 2)}\n`,
          { mode: 0o600 },
        );
        if (
          result.phase === "resolved" &&
          result.autopsy?.status === "verified" &&
          result.autopsy.breaker
        ) {
          const receipt = publicReceipt({
            result,
            client: snapshot,
            events,
            breaker: result.autopsy.breaker,
            mode: "live-twitch",
          });
          const path = await saveReceipt(join(ROOT, "docs/rounds"), receipt);
          console.log(
            `Verified round ${result.roundId}; public receipt: ${path}`,
          );
        } else
          console.log(
            `Round ${result.roundId} ended ${result.phase}; private evidence retained.`,
          );
        await live.flush();
        await writes;
        if (failure) throw failure;
      },
      fatal,
    );
    live.attach(gate.adapter);
    listener = createEventSub({
      auth,
      broadcasterId: account.userId,
      handler: live.handler,
      status: (status) => {
        console.log(`EventSub ${status}`);
        record({ type: "eventsub.status", status });
      },
    });
    console.log(
      `Overlay: ${server.origin}/?bridge=${encodeURIComponent(server.origin)}`,
    );
    console.log(
      flags.allowBroadcasterTest
        ? "Listening on steve_sociall in broadcaster-test mode. One round at a time, 15 s chat head start, 60 s race, 240 s repair backstop. Broadcaster chat commands accepted; bot replies ignored."
        : "Listening on steve_sociall while online or offline. One round at a time, 15 s chat head start, 60 s race, 240 s repair backstop. Bot-authored messages are ignored; use another viewer account for commands.",
    );
    if (flags.dryChat)
      console.log(
        "Dry chat: outgoing lines are logged; no chat, markers, clips, pins, reward creation or reward updates are sent.",
      );
    abort.signal.throwIfAborted();
    listener.start();
    await new Promise<void>((done) => {
      if (abort.signal.aborted) done();
      else abort.signal.addEventListener("abort", () => done(), { once: true });
    });
  } finally {
    signal.removeEventListener("abort", stop);
    await closeLiveResources([
      () => listener?.stop(),
      () => engine?.stop(),
      () => gate?.drain(),
      () => controller?.close(),
      () => deliveries,
      () => writes,
      () => server?.close(),
      () => client?.close(),
    ]);
  }
  if (failure)
    throw new Error(
      "Live session stopped after an event, recording or receipt failure. Private evidence was retained.",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  runLiveCli(process.argv.slice(2), shutdown.signal)
    .catch(() => {
      console.error(
        "Live round startup or execution failed. See the printed private log directory. Credentials and remote response bodies were withheld; no retry was attempted.",
      );
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
}
