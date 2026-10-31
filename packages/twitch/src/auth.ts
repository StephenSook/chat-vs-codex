import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type AccessToken,
  type DeviceCodeInfo,
  RefreshingAuthProvider,
} from "@twurple/auth";
import { createOAuthTransport, type OAuthTransport } from "./auth-transport.js";

const REQUEST_TIMEOUT_MS = 20_000;
type AuthDependencies = {
  transport?: OAuthTransport;
  now?: () => number;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
};

async function bounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AuthDependencies,
  remainingMs = Number.POSITIVE_INFINITY,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = Math.min(
    options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    remainingMs,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Twitch authorization request deadline expired.");
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Twitch authorization request deadline expired."),
      ),
    timeoutMs,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    signal.throwIfAborted();
    return await operation(signal);
  } finally {
    clearTimeout(timer);
  }
}

export const SCOPES = [
  "user:read:chat",
  "user:write:chat",
  "user:read:whispers",
  "channel:read:redemptions",
  "channel:manage:redemptions",
  "bits:read",
  "channel:manage:broadcast",
  "clips:edit",
  "moderator:manage:chat_messages",
  "channel:read:hype_train",
  "moderator:read:followers",
] as const;

export function requireClientId(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.TWITCH_CLIENT_ID?.trim();
  if (!value || !/^[a-z0-9]+$/i.test(value))
    throw new Error(
      "Set TWITCH_CLIENT_ID to the public Twitch application Client ID.",
    );
  return value;
}

export function privateJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink())
    throw new Error("Credential directory must not be a symlink.");
  chmodSync(dir, 0o700);
  const temp = join(dir, `.${randomUUID()}.json`);
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

export interface StoredToken {
  clientId: string;
  userId: string;
  token: AccessToken;
}
export interface PendingDevice {
  clientId: string;
  device: DeviceCodeInfo;
  expiresAt: number;
  nextPollAt: number;
}
export const tokenPath = () =>
  fileURLToPath(new URL("../../../.local/twitch/tokens.json", import.meta.url));

export function readToken(path = tokenPath()): StoredToken {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("Token file must be a regular file with mode 0600.");
  const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!stored || typeof stored !== "object")
    throw new Error("Invalid token file.");
  const data = stored as Partial<StoredToken>;
  const token = data.token;
  if (
    typeof data.clientId !== "string" ||
    typeof data.userId !== "string" ||
    !token ||
    typeof token.accessToken !== "string" ||
    !token.accessToken ||
    typeof token.refreshToken !== "string" ||
    !Array.isArray(token.scope) ||
    !token.scope.every((s) => typeof s === "string") ||
    typeof token.obtainmentTimestamp !== "number" ||
    !(token.expiresIn === null || typeof token.expiresIn === "number")
  )
    throw new Error("Invalid token file.");
  return data as StoredToken;
}

export function createAuth(
  stored: StoredToken,
  path = tokenPath(),
): RefreshingAuthProvider {
  const auth = new RefreshingAuthProvider({ clientId: stored.clientId });
  auth.onRefresh((userId, token) =>
    privateJson(path, { clientId: stored.clientId, userId, token }),
  );
  auth.addUser(stored.userId, stored.token, ["chat"]);
  return auth;
}

export async function beginAuthorization(
  clientId: string,
  pendingPath: string,
  dependencies: AuthDependencies = {},
): Promise<Pick<DeviceCodeInfo, "verificationUri" | "userCode" | "expiresIn">> {
  const now = dependencies.now ?? Date.now;
  const transport = dependencies.transport ?? createOAuthTransport();
  const device = await bounded(
    (signal) => transport.start(clientId, [...SCOPES], signal),
    dependencies,
  );
  const startedAt = now();
  privateJson(pendingPath, {
    clientId,
    device,
    expiresAt: startedAt + device.expiresIn * 1000,
    nextPollAt: startedAt + device.interval * 1000,
  } satisfies PendingDevice);
  return {
    verificationUri: device.verificationUri,
    userCode: device.userCode,
    expiresIn: device.expiresIn,
  };
}

function oauthError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  let body: unknown = "body" in error ? error.body : undefined;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return "unknown";
    }
  }
  if (body && typeof body === "object") {
    if ("message" in body && typeof body.message === "string")
      return body.message;
    if ("error" in body && typeof body.error === "string") return body.error;
  }
  return "unknown";
}

export async function pollAuthorization(
  pending: PendingDevice,
  dependencies: {
    exchange?: OAuthTransport["exchange"];
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    savePending?: (next: PendingDevice) => void;
  } & AuthDependencies = {},
): Promise<AccessToken> {
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    (async (ms, signal) => {
      await delay(ms, undefined, signal ? { signal } : {});
    });
  let interval = pending.device.interval * 1000;
  let nextPollAt = pending.nextPollAt;
  while (now() < pending.expiresAt) {
    dependencies.signal?.throwIfAborted();
    await wait(
      Math.max(0, Math.min(nextPollAt, pending.expiresAt) - now()),
      dependencies.signal,
    );
    if (now() >= pending.expiresAt) break;
    // Persist the next allowed attempt before network I/O, including across resumes.
    nextPollAt = now() + interval;
    dependencies.savePending?.({ ...pending, nextPollAt });
    try {
      const exchange =
        dependencies.exchange ??
        (dependencies.transport ?? createOAuthTransport()).exchange;
      return await bounded(
        (signal) =>
          exchange(
            pending.clientId,
            pending.device.deviceCode,
            [...SCOPES],
            signal,
          ),
        dependencies,
        pending.expiresAt - now(),
      );
    } catch (error) {
      const reason = oauthError(error);
      if (reason === "slow_down") {
        interval += 5000;
        nextPollAt = now() + interval;
        pending = {
          ...pending,
          device: { ...pending.device, interval: interval / 1000 },
        };
        dependencies.savePending?.({ ...pending, nextPollAt });
      } else if (reason !== "authorization_pending") {
        if (reason === "access_denied")
          throw new Error("Twitch authorization was declined.");
        if (reason === "expired_token")
          throw new Error(
            "Twitch device code expired. Start authorization again.",
          );
        throw new Error(
          "Twitch device token exchange failed. No credentials were logged.",
        );
      }
    }
  }
  throw new Error("Twitch device code expired. Start authorization again.");
}

export async function finishAuthorization(
  pendingPath: string,
  clientId: string,
  path = tokenPath(),
  dependencies: AuthDependencies = {},
): Promise<string> {
  const pending = JSON.parse(
    readFileSync(pendingPath, "utf8"),
  ) as PendingDevice;
  if (
    pending.clientId !== clientId ||
    !Number.isFinite(pending.expiresAt) ||
    !Number.isFinite(pending.nextPollAt) ||
    !pending.device ||
    typeof pending.device.deviceCode !== "string" ||
    !Number.isFinite(pending.device.interval) ||
    pending.device.interval < 1
  )
    throw new Error(
      "Invalid pending Twitch authorization. Start authorization again.",
    );
  const token = await pollAuthorization(pending, {
    ...dependencies,
    savePending: (next) => privateJson(pendingPath, next),
  });
  const validated = await bounded(
    (signal) =>
      (dependencies.transport ?? createOAuthTransport()).validate(
        token.accessToken,
        signal,
      ),
    dependencies,
    pending.expiresAt - (dependencies.now ?? Date.now)(),
  );
  if (
    validated.clientId !== clientId ||
    !validated.userId ||
    validated.expiresIn <= 0 ||
    !SCOPES.every((scope) => validated.scopes.includes(scope))
  )
    throw new Error("Invalid Twitch authorization identity or granted scopes.");
  const userId = validated.userId;
  // No addUserForToken call: it may rotate a token during its validation path.
  // The exact freshly exchanged, directly validated token is the one persisted.
  privateJson(path, {
    clientId,
    userId,
    token: { ...token, scope: validated.scopes },
  } satisfies StoredToken);
  rmSync(pendingPath);
  return userId;
}
