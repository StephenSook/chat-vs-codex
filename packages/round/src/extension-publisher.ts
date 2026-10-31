import { createHmac } from "node:crypto";
import {
  type PublicRoundState,
  parsePublicRoundState,
} from "./public-state.js";

export interface ExtensionCredentials {
  clientId: string;
  broadcasterId: string;
  ownerId: string;
  sharedSecret: string;
}
export function extensionCredentials(
  env: NodeJS.ProcessEnv,
  broadcasterId: string,
): ExtensionCredentials | undefined {
  if (env.EXTENSION_ENABLED !== "1") return undefined;
  const clientId = env.TWITCH_EXTENSION_CLIENT_ID ?? "";
  const sharedSecret = env.TWITCH_EXTENSION_SECRET ?? "";
  const ownerId = env.TWITCH_EXTENSION_OWNER_ID ?? "";
  if (
    !/^[a-zA-Z0-9]+$/.test(clientId) ||
    !/^[0-9]+$/.test(broadcasterId) ||
    !/^[0-9]+$/.test(ownerId) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(sharedSecret) ||
    Buffer.from(sharedSecret, "base64").length < 32 ||
    Buffer.from(sharedSecret, "base64").toString("base64") !== sharedSecret
  )
    throw new Error(
      "Extension publishing requires its separate Client ID, numeric owner ID and base64 shared secret (at least 32 bytes). Keep the secret in the host credential store.",
    );
  return { clientId, broadcasterId, ownerId, sharedSecret };
}

/** Extension JWT only, never a user's OAuth token. Scope to this one channel. */
export function extensionJwt(
  credentials: ExtensionCredentials,
  nowMs: number,
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: Math.floor(nowMs / 1000) + 60, user_id: credentials.ownerId, role: "external", channel_id: credentials.broadcasterId, pubsub_perms: { send: ["broadcast"] } })}`;
  return `${body}.${createHmac("sha256", Buffer.from(credentials.sharedSecret, "base64")).update(body).digest("base64url")}`;
}

/** Coalesced snapshots, at most once each second, including late-joining panel viewers.
 * A heartbeat transports existing measured state; it never advances a round or SDK step.
 */
export class ExtensionPublisher {
  private latest: PublicRoundState | undefined;
  private busy = false;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private options: {
      credentials: ExtensionCredentials;
      fetch?: typeof fetch;
      now?: () => number;
      report?: (entry: {
        type: "extension.pubsub";
        status: number | "transport-error";
      }) => void;
    },
  ) {}
  update(state: PublicRoundState) {
    this.latest = parsePublicRoundState(state);
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, 1000);
    this.timer.unref();
  }
  async flush(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (
      this.stopped ||
      this.busy ||
      !this.latest ||
      now - this.lastAttempt < 1000
    )
      return;
    this.lastAttempt = now;
    this.busy = true;
    const message = JSON.stringify({
      ...this.latest,
      updatedAt: new Date(now).toISOString(),
    });
    this.pending = (async () => {
      try {
        if (Buffer.byteLength(message) > 5000)
          throw new Error("Public snapshot exceeds Twitch message limit");
        const response = await (this.options.fetch ?? fetch)(
          "https://api.twitch.tv/helix/extensions/pubsub",
          {
            method: "POST",
            headers: {
              "Client-Id": this.options.credentials.clientId,
              Authorization: `Bearer ${extensionJwt(this.options.credentials, now)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              broadcaster_id: this.options.credentials.broadcasterId,
              target: ["broadcast"],
              message,
            }),
            signal: AbortSignal.any([
              this.abort.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        // Remote bodies and headers can reflect credentials. Retain only numeric status.
        this.options.report?.({
          type: "extension.pubsub",
          status: response.status,
        });
      } catch {
        if (!this.stopped)
          this.options.report?.({
            type: "extension.pubsub",
            status: "transport-error",
          });
      } finally {
        this.busy = false;
      }
    })();
    await this.pending;
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.pending;
  }
}
