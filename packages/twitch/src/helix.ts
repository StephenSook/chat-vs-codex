/** Raw Helix adapter. Tokens stay in headers and never enter diagnostic text.
 * Endpoint contracts: https://dev.twitch.tv/docs/api/reference/#send-chat-message
 * https://dev.twitch.tv/docs/api/reference/#pin-chat-message
 * https://dev.twitch.tv/docs/api/reference/#get-streams
 * https://dev.twitch.tv/docs/api/reference/#create-stream-marker
 * https://dev.twitch.tv/docs/api/reference/#create-clip
 */
export interface LiveHelix {
  isLive(): Promise<boolean>;
  chat(message: string): Promise<string>;
  marker(description: string): Promise<void>;
  clip(): Promise<void>;
  pin(messageId: string): Promise<void>;
  /** Read only; custom Power-ups are created in the broadcaster dashboard. */
  powerUp?(
    id: string,
  ): Promise<{ id: string; broadcasterId: string; title: string }>;
}

export class TwitchRefusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Twitch ${status}: ${reason}`);
  }
}

export function createLiveHelix(options: {
  clientId: string;
  broadcasterId: string;
  senderId: string;
  accessToken(): Promise<string>;
  fetch?: typeof fetch;
}): LiveHelix {
  const fetcher = options.fetch ?? fetch;
  async function request(
    path: string,
    method: "GET" | "POST" | "PUT",
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const token = await options.accessToken();
    const response = await fetcher(
      `https://api.twitch.tv/helix/${path}?${new URLSearchParams(query)}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Client-Id": options.clientId,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data: unknown = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      const reason =
        data &&
        typeof data === "object" &&
        "message" in data &&
        typeof data.message === "string"
          ? data.message
              .replaceAll(token, "[redacted]")
              .replace(/[\r\n]/g, " ")
              .slice(0, 300)
          : "request refused";
      throw new TwitchRefusal(response.status, reason);
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid Twitch response");
    return data as Record<string, unknown>;
  }
  const rows = (data: Record<string, unknown>): Record<string, unknown>[] => {
    if (
      !Array.isArray(data.data) ||
      !data.data.every(
        (row) => row && typeof row === "object" && !Array.isArray(row),
      )
    )
      throw new Error("Invalid Twitch data response");
    return data.data as Record<string, unknown>[];
  };
  return {
    async isLive() {
      return rows(
        await request("streams", "GET", { user_id: options.broadcasterId }),
      ).some(
        (row) => row.user_id === options.broadcasterId && row.type === "live",
      );
    },
    async chat(message) {
      const row = rows(
        await request(
          "chat/messages",
          "POST",
          {},
          {
            broadcaster_id: options.broadcasterId,
            sender_id: options.senderId,
            message,
          },
        ),
      )[0];
      if (
        row?.is_sent !== true ||
        typeof row.message_id !== "string" ||
        !row.message_id
      ) {
        const drop = row?.drop_reason;
        const code =
          drop &&
          typeof drop === "object" &&
          "code" in drop &&
          typeof drop.code === "string"
            ? drop.code
            : "message_not_sent";
        throw new TwitchRefusal(200, code.slice(0, 100));
      }
      return row.message_id;
    },
    async marker(description) {
      await request(
        "streams/markers",
        "POST",
        {},
        { user_id: options.broadcasterId, description },
      );
    },
    async clip() {
      const row = rows(
        await request("clips", "POST", {
          broadcaster_id: options.broadcasterId,
        }),
      )[0];
      if (!row || typeof row.id !== "string" || !row.id)
        throw new Error("Twitch did not accept a clip request");
    },
    async powerUp(id) {
      const row = rows(
        await request("bits/custom_power_ups", "GET", {
          broadcaster_id: options.broadcasterId,
          id,
        }),
      ).find(
        (entry) =>
          entry.id === id && entry.broadcaster_id === options.broadcasterId,
      );
      if (!row || typeof row.title !== "string")
        throw new Error("Twitch did not return the requested custom Power-up");
      return { id, broadcasterId: options.broadcasterId, title: row.title };
    },
    async pin(messageId) {
      // The GA endpoint uses QUERY parameters, not a JSON body. Twurple has no pin helper.
      await request("chat/pins", "PUT", {
        broadcaster_id: options.broadcasterId,
        moderator_id: options.senderId,
        message_id: messageId,
        duration_seconds: "1200",
      });
    },
  };
}
