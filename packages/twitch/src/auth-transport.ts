import type { AccessToken, DeviceCodeInfo } from "@twurple/auth";

export interface ValidatedToken {
  clientId: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
}
export interface OAuthTransport {
  start(
    clientId: string,
    scopes: string[],
    signal: AbortSignal,
  ): Promise<DeviceCodeInfo>;
  exchange(
    clientId: string,
    deviceCode: string,
    scopes: string[],
    signal: AbortSignal,
  ): Promise<AccessToken>;
  validate(accessToken: string, signal: AbortSignal): Promise<ValidatedToken>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Twitch authorization response.");
  return value as Record<string, unknown>;
}
function text(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value)
    throw new Error("Invalid Twitch authorization response.");
  return value;
}
function positive(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error("Invalid Twitch authorization response.");
  return value;
}
function scopes(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (
    !Array.isArray(value) ||
    !value.every((scope) => typeof scope === "string")
  )
    throw new Error("Invalid Twitch authorization response.");
  return value as string[];
}

/** Twurple's high-level OAuth helpers do not accept a signal. Node 22 fetch does,
 * including response body consumption, so device grant I/O uses this small helper. */
export function createOAuthTransport(
  fetcher: typeof fetch = fetch,
  now = Date.now,
): OAuthTransport {
  async function request(
    path: "device" | "token" | "validate",
    signal: AbortSignal,
    form?: URLSearchParams,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const response = await fetcher(`https://id.twitch.tv/oauth2/${path}`, {
      method: form ? "POST" : "GET",
      headers: form
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : { Authorization: `OAuth ${accessToken}` },
      ...(form ? { body: form } : {}),
      signal,
    });
    const data = object(await response.json());
    if (!response.ok) {
      const reason =
        typeof data.message === "string" ? data.message : data.error;
      const allowed = [
        "authorization_pending",
        "slow_down",
        "access_denied",
        "expired_token",
      ];
      const safe =
        typeof reason === "string" && allowed.includes(reason)
          ? reason
          : "unknown";
      throw Object.assign(new Error("Twitch authorization request failed."), {
        body: { error: safe },
      });
    }
    return data;
  }
  return {
    async start(clientId, requestedScopes, signal) {
      const data = await request(
        "device",
        signal,
        new URLSearchParams({
          client_id: clientId,
          scopes: requestedScopes.join(" "),
        }),
      );
      const verificationUri = text(data, "verification_uri");
      const url = new URL(verificationUri);
      if (
        url.protocol !== "https:" ||
        !["www.twitch.tv", "twitch.tv"].includes(url.hostname)
      )
        throw new Error("Invalid Twitch authorization verification URL.");
      return {
        deviceCode: text(data, "device_code"),
        userCode: text(data, "user_code"),
        verificationUri,
        expiresIn: positive(data, "expires_in"),
        interval: positive(data, "interval"),
      };
    },
    async exchange(clientId, deviceCode, requestedScopes, signal) {
      const data = await request(
        "token",
        signal,
        new URLSearchParams({
          client_id: clientId,
          device_code: deviceCode,
          scopes: requestedScopes.join(" "),
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      return {
        accessToken: text(data, "access_token"),
        refreshToken: text(data, "refresh_token"),
        scope: scopes(data, "scope"),
        expiresIn: positive(data, "expires_in"),
        obtainmentTimestamp: now(),
      };
    },
    async validate(accessToken, signal) {
      const data = await request("validate", signal, undefined, accessToken);
      return {
        clientId: text(data, "client_id"),
        userId: text(data, "user_id"),
        scopes: scopes(data, "scopes"),
        expiresIn: positive(data, "expires_in"),
      };
    },
  };
}
