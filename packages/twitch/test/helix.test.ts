import { describe, expect, it, vi } from "vitest";
import { createLiveHelix, TwitchRefusal } from "../src/helix.js";

function setup(responses: { status?: number; body?: unknown }[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected fetch");
      return new Response(
        next.status === 204 ? null : JSON.stringify(next.body),
        { status: next.status ?? 200 },
      );
    },
  ) as unknown as typeof fetch;
  const helix = createLiveHelix({
    clientId: "client",
    broadcasterId: "channel",
    senderId: "channel",
    accessToken: async () => "private-test-token",
    fetch: fetcher,
  });
  return { helix, calls };
}
describe("raw authenticated Helix actions", () => {
  it("sets the real Create Clip title query and returns the public URL with accepted status", async () => {
    const { helix, calls } = setup([
      { status: 202, body: { data: [{ id: "real-clip" }] } },
    ]);
    expect(await helix.clip("Codex fixed gravity-sign in 16.7 s")).toEqual({
      id: "real-clip",
      url: "https://clips.twitch.tv/real-clip",
      titlePath: "accepted",
    });
    expect(calls[0]?.url.searchParams.get("title")).toBe(
      "Codex fixed gravity-sign in 16.7 s",
    );
  });
  it("falls back without a title on HTTP400 and retains the title refusal", async () => {
    const { helix, calls } = setup([
      { status: 400, body: { message: "Unknown title parameter" } },
      { status: 202, body: { data: [{ id: "fallback-clip" }] } },
    ]);
    expect(await helix.clip("Codex fixed jump-buffer in 12.0 s")).toEqual({
      id: "fallback-clip",
      url: "https://clips.twitch.tv/fallback-clip",
      titlePath: "fallback",
      titleRefusal: "Twitch 400: Unknown title parameter",
    });
    expect(calls[0]?.url.searchParams.has("title")).toBe(true);
    expect(calls[1]?.url.searchParams.has("title")).toBe(false);
  });
  it("does not retry titleless or non400 clip failures", async () => {
    for (const title of [undefined, "Requested title"]) {
      const { helix, calls } = setup([
        { status: title ? 403 : 400, body: { message: "Refused" } },
      ]);
      await expect(helix.clip(title)).rejects.toThrow("Refused");
      expect(calls).toHaveLength(1);
    }
  });
  it("gets custom Power-up metadata by broadcaster and exact redemption id", async () => {
    const { helix, calls } = setup([
      {
        body: {
          data: [
            { id: "power", broadcaster_id: "channel", title: "Break the game" },
          ],
        },
      },
    ]);
    expect(await helix.powerUp?.("power")).toEqual({
      id: "power",
      broadcasterId: "channel",
      title: "Break the game",
    });
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/helix/bits/custom_power_ups");
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      broadcaster_id: "channel",
      id: "power",
    });
  });
  it("refuses custom Power-up metadata for another broadcaster or id", async () => {
    const { helix } = setup([
      {
        body: {
          data: [
            { id: "power", broadcaster_id: "another", title: "Break the game" },
          ],
        },
      },
    ]);
    await expect(helix.powerUp?.("power")).rejects.toThrow(
      "requested custom Power-up",
    );
  });
  it("detects live only from the channel's Get Streams result", async () => {
    const { helix, calls } = setup([
      { body: { data: [] } },
      { body: { data: [{ user_id: "channel", type: "live" }] } },
    ]);
    expect(await helix.isLive()).toBe(false);
    expect(await helix.isLive()).toBe(true);
    expect(calls[0]?.url.pathname).toBe("/helix/streams");
    expect(calls[0]?.url.searchParams.get("user_id")).toBe("channel");
  });
  it("uses user-token Send Chat Message with no app-token-only fields", async () => {
    const { helix, calls } = setup([
      { body: { data: [{ is_sent: true, message_id: "actual-message" }] } },
    ]);
    expect(await helix.chat("Something broke. Chat has 15 s.")).toBe(
      "actual-message",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      broadcaster_id: "channel",
      sender_id: "channel",
      message: "Something broke. Chat has 15 s.",
    });
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer private-test-token",
      "Client-Id": "client",
    });
    expect(calls[0]?.url.href).not.toContain("private-test-token");
  });
  it("pins the actual chat message using GA query parameters with PUT and no JSON body", async () => {
    const { helix, calls } = setup([{ status: 204 }]);
    await helix.pin("actual-message");
    expect(calls[0]?.url.pathname).toBe("/helix/chat/pins");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({
      broadcaster_id: "channel",
      moderator_id: "channel",
      message_id: "actual-message",
      duration_seconds: "1200",
    });
  });
  it("creates marker and accepts a clip request without claiming clip publication", async () => {
    const { helix, calls } = setup([
      { body: { data: [{ id: "marker" }] } },
      {
        status: 202,
        body: {
          data: [{ id: "clip-id", edit_url: "https://clips.twitch.tv/edit" }],
        },
      },
    ]);
    await helix.marker("fix-landed");
    await helix.clip();
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/helix/streams/markers",
      "/helix/clips",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      user_id: "channel",
      description: "fix-landed",
    });
    expect(calls[1]?.url.searchParams.get("broadcaster_id")).toBe("channel");
  });
  it("treats an HTTP200 chat drop as refusal and records the drop code", async () => {
    const { helix } = setup([
      {
        body: {
          data: [
            {
              is_sent: false,
              drop_reason: {
                code: "automod_held",
                message: "secret free text",
              },
            },
          ],
        },
      },
    ]);
    await expect(helix.chat("result")).rejects.toThrow("automod_held");
  });
  it("preserves refusal reasons while redacting a reflected access token", async () => {
    const { helix } = setup([
      { status: 403, body: { message: "VOD disabled private-test-token" } },
    ]);
    let failure: unknown;
    try {
      await helix.marker("fix-landed");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TwitchRefusal);
    expect(String(failure)).toContain("VOD disabled [redacted]");
    expect(String(failure)).not.toContain("private-test-token");
  });
});

it("reads and changes only the broadcaster's title through the real channel API contract", async () => {
  const { helix, calls } = setup([
    { body: { data: [{ broadcaster_id: "channel", title: "Exact  title!" }] } },
    { status: 204 },
  ]);
  expect(await helix.channelTitle?.()).toBe("Exact  title!");
  await helix.setChannelTitle?.("[CHAT 0 : CODEX 1] Exact  title!");
  expect(calls.map((call) => call.url.pathname)).toEqual([
    "/helix/channels",
    "/helix/channels",
  ]);
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "PATCH"]);
  expect(calls[1]?.url.searchParams.get("broadcaster_id")).toBe("channel");
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
    title: "[CHAT 0 : CODEX 1] Exact  title!",
  });
});
it("refuses title lookup mismatches and invalid writes without exposing credentials", async () => {
  const { helix, calls } = setup([
    { body: { data: [{ broadcaster_id: "other", title: "Wrong" }] } },
  ]);
  await expect(helix.channelTitle?.()).rejects.toThrow("channel title");
  await expect(helix.setChannelTitle?.("")).rejects.toThrow("1 to 140");
  await expect(helix.setChannelTitle?.("x".repeat(141))).rejects.toThrow(
    "1 to 140",
  );
  expect(calls).toHaveLength(1);
});
