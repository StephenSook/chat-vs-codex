import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionPublisher,
  extensionCredentials,
  extensionJwt,
} from "../src/extension-publisher.js";
import { PublicRoundProjection } from "../src/public-state.js";

const credentials = {
  clientId: "fixtureextension",
  broadcasterId: "42",
  ownerId: "99",
  sharedSecret: Buffer.alloc(32, 7).toString("base64"),
};

describe("Extension publisher", () => {
  it("is disabled by default and requires separate, valid extension credentials", () => {
    expect(extensionCredentials({}, "42")).toBeUndefined();
    expect(() =>
      extensionCredentials(
        { EXTENSION_ENABLED: "1", TWITCH_CLIENT_ID: "chat-app-not-extension" },
        "42",
      ),
    ).toThrow("separate Client ID");
    expect(
      extensionCredentials(
        {
          EXTENSION_ENABLED: "1",
          TWITCH_EXTENSION_CLIENT_ID: credentials.clientId,
          TWITCH_EXTENSION_OWNER_ID: credentials.ownerId,
          TWITCH_EXTENSION_SECRET: credentials.sharedSecret,
        },
        "42",
      ),
    ).toEqual(credentials);
  });
  it("requires a numeric Extension owner only when publishing is enabled", () => {
    const env = {
      EXTENSION_ENABLED: "1",
      TWITCH_EXTENSION_CLIENT_ID: credentials.clientId,
      TWITCH_EXTENSION_SECRET: credentials.sharedSecret,
    };
    expect(() => extensionCredentials(env, "42")).toThrow("numeric owner ID");
    for (const owner of ["", "owner-name", "-1", "1.5"])
      expect(() =>
        extensionCredentials(
          { ...env, TWITCH_EXTENSION_OWNER_ID: owner },
          "42",
        ),
      ).toThrow("numeric owner ID");
    expect(
      extensionCredentials(
        {
          ...env,
          EXTENSION_ENABLED: "0",
          TWITCH_EXTENSION_OWNER_ID: "invalid-but-disabled",
        },
        "42",
      ),
    ).toBeUndefined();
  });
  it("signs a 60-second HS256 JWT constrained to this channel's broadcast topic", () => {
    const token = extensionJwt(credentials, 100000);
    const [header, payload, signature] = token.split(".");
    expect(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString()),
    ).toEqual({ alg: "HS256", typ: "JWT" });
    expect(
      JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
    ).toEqual({
      exp: 160,
      user_id: "99",
      role: "external",
      channel_id: "42",
      pubsub_perms: { send: ["broadcast"] },
    });
    expect(signature).toBe(
      createHmac("sha256", Buffer.from(credentials.sharedSecret, "base64"))
        .update(`${header}.${payload}`)
        .digest("base64url"),
    );
  });
  it("coalesces measured states, throttles to one per second and redacts remote responses", async () => {
    let now = 100000;
    const transport = vi.fn<typeof fetch>(
      async () => new Response("reflected secret", { status: 403 }),
    );
    const reports: unknown[] = [];
    const publisher = new ExtensionPublisher({
      credentials,
      fetch: transport,
      now: () => now,
      report: (entry) => reports.push(entry),
    });
    const projection = new PublicRoundProjection({ mode: "live-twitch" });
    publisher.update(projection.snapshot(new Date(now).toISOString()));
    await publisher.flush();
    await publisher.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([{ type: "extension.pubsub", status: 403 }]);
    const [url, request] = transport.mock.calls[0] ?? [];
    expect(url).toBe("https://api.twitch.tv/helix/extensions/pubsub");
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      broadcaster_id: "42",
      target: ["broadcast"],
    });
    expect(JSON.parse(body.message)).toEqual(
      projection.snapshot(new Date(now).toISOString()),
    );
    expect(Buffer.byteLength(body.message)).toBeLessThan(5000);
    now += 1000;
    await publisher.flush();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(reports)).not.toContain("secret");
    await publisher.close();
    now += 1000;
    await publisher.flush();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("never overlaps network requests or manufactures activities while blocked", async () => {
    let release: (() => void) | undefined;
    let now = 100000;
    const transport = vi.fn<typeof fetch>(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return new Response(null, { status: 204 });
    });
    const publisher = new ExtensionPublisher({
      credentials,
      fetch: transport,
      now: () => now,
    });
    const projection = new PublicRoundProjection();
    publisher.update(projection.snapshot(new Date(now).toISOString()));
    const first = publisher.flush();
    now += 2000;
    await publisher.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    expect(
      JSON.parse(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).message)
        .step,
    ).toBeNull();
    await publisher.close();
  });
});
