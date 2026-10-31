import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccessToken } from "@twurple/auth";
import { describe, expect, it, vi } from "vitest";
import {
  beginAuthorization,
  createAuth,
  finishAuthorization,
  type PendingDevice,
  pollAuthorization,
  privateJson,
  readToken,
  requireClientId,
  SCOPES,
} from "../src/auth.js";
import {
  createOAuthTransport,
  type OAuthTransport,
} from "../src/auth-transport.js";

const token: AccessToken = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  scope: ["user:read:chat"],
  expiresIn: 3600,
  obtainmentTimestamp: 0,
};
const pending: PendingDevice = {
  clientId: "testclient",
  device: {
    deviceCode: "test-device",
    userCode: "ABCD",
    verificationUri: "https://www.twitch.tv/activate",
    expiresIn: 60,
    interval: 2,
  },
  expiresAt: 60_000,
  nextPollAt: 2000,
};

describe("public-client Twitch authorization", () => {
  it("requires a Client ID and never invents one", () => {
    expect(() => requireClientId({})).toThrow("TWITCH_CLIENT_ID");
    expect(requireClientId({ TWITCH_CLIENT_ID: " publicclient " })).toBe(
      "publicclient",
    );
  });
  it("persists tokens atomically at mode 0600 and records provider refreshes", () => {
    const dir = mkdtempSync(join(tmpdir(), "twitch-auth-"));
    try {
      const path = join(dir, "credentials/tokens.json");
      const stored = { clientId: "testclient", userId: "123", token };
      privateJson(path, stored);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "credentials")).mode & 0o777).toBe(0o700);
      expect(readToken(path)).toEqual(stored);
      const provider = createAuth(stored, path);
      const refreshed = {
        ...token,
        accessToken: "test-new-access",
        refreshToken: "test-rotated-refresh",
      };
      Reflect.apply(Reflect.get(provider, "emit"), provider, [
        provider.onRefresh,
        "123",
        refreshed,
      ]);
      expect(JSON.parse(readFileSync(path, "utf8")).token).toEqual(refreshed);
      chmodSync(path, 0o644);
      expect(() => readToken(path)).toThrow("0600");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("honors first poll interval, authorization_pending and slow_down across resumes", async () => {
    let time = 0;
    const waits: number[] = [];
    const exchange = vi
      .fn()
      .mockRejectedValueOnce({ body: '{"message":"authorization_pending"}' })
      .mockRejectedValueOnce({ body: '{"error":"slow_down"}' })
      .mockResolvedValue(token);
    const savePending = vi.fn();
    expect(
      await pollAuthorization(pending, {
        now: () => time,
        wait: async (ms) => {
          waits.push(ms);
          time += ms;
        },
        exchange,
        savePending,
      }),
    ).toEqual(token);
    expect(waits).toEqual([2000, 2000, 7000]);
    expect(
      savePending.mock.calls.some(([value]) => value.device.interval === 7),
    ).toBe(true);
    expect(exchange).toHaveBeenCalledWith(
      "testclient",
      "test-device",
      expect.arrayContaining(["user:read:chat"]),
      expect.any(AbortSignal),
    );
  });
  it("expires or refuses without logging the remote response", async () => {
    await expect(
      pollAuthorization({ ...pending, expiresAt: 0 }, { now: () => 0 }),
    ).rejects.toThrow("expired");
    const exchange = vi.fn().mockRejectedValue({
      body: '{"message":"access_denied","access_token":"must-not-appear"}',
    });
    await expect(
      pollAuthorization(pending, {
        now: () => 2000,
        wait: async () => {},
        exchange,
      }),
    ).rejects.toThrow("declined");
    const signal = AbortSignal.abort();
    await expect(
      pollAuthorization(pending, { signal, now: () => 0 }),
    ).rejects.toThrow();
  });
});

function hangingFetch(onSignal: (signal: AbortSignal) => void): typeof fetch {
  return async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing network cancellation signal");
      onSignal(signal);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
}

describe("bounded device grant transport", () => {
  it("aborts a hanging device-start fetch and writes no pending grant", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "twitch-start-"));
    const path = join(dir, "pending.json");
    let signal: AbortSignal | undefined;
    try {
      const task = beginAuthorization("testclient", path, {
        transport: createOAuthTransport(
          hangingFetch((value) => {
            signal = value;
          }),
        ),
        requestTimeoutMs: 50,
      });
      const rejected = expect(task).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(existsSync(path)).toBe(false);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("aborts an exchange at device expiry even when the per-request timeout is longer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let signal: AbortSignal | undefined;
    try {
      const task = pollAuthorization(
        { ...pending, nextPollAt: 0, expiresAt: 40 },
        {
          transport: createOAuthTransport(
            hangingFetch((value) => {
              signal = value;
            }),
          ),
          requestTimeoutMs: 1000,
          wait: async () => {},
        },
      );
      const rejected = expect(task).rejects.toThrow("exchange failed");
      await Promise.resolve();
      expect(signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels in-progress exchange with caller abort and stops pending response body consumption", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing abort signal");
      received = signal;
      return new Response(
        new ReadableStream({
          start(stream) {
            signal.addEventListener(
              "abort",
              () => stream.error(signal.reason),
              { once: true },
            );
          },
        }),
      );
    };
    const task = pollAuthorization(
      { ...pending, nextPollAt: 0 },
      {
        now: () => 0,
        wait: async () => {},
        signal: controller.signal,
        transport: createOAuthTransport(fetcher),
      },
    );
    const rejected = expect(task).rejects.toThrow("exchange failed");
    await vi.waitFor(() => expect(received).toBeDefined());
    controller.abort();
    await rejected;
    expect(received?.aborted).toBe(true);
  });
  it("uses public-client form requests and validates via OAuth header without a client secret", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "device",
          user_code: "USER",
          verification_uri: "https://www.twitch.tv/activate",
          expires_in: 600,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          scope: [...SCOPES],
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          client_id: "testclient",
          user_id: "123",
          scopes: [...SCOPES],
          expires_in: 3599,
        }),
      );
    const transport = createOAuthTransport(fetcher, () => 77);
    const signal = new AbortController().signal;
    await transport.start("testclient", [...SCOPES], signal);
    expect(
      (await transport.exchange("testclient", "device", [...SCOPES], signal))
        .obtainmentTimestamp,
    ).toBe(77);
    await transport.validate("new-access", signal);
    const first = fetcher.mock.calls[0]?.[1];
    expect(first?.body?.toString()).toContain("client_id=testclient");
    expect(first?.body?.toString()).not.toContain("client_secret");
    expect(fetcher.mock.calls[2]?.[1]?.headers).toEqual({
      Authorization: "OAuth new-access",
    });
    expect(
      fetcher.mock.calls.every(([, init]) => init?.signal === signal),
    ).toBe(true);
  });
  it("persists the directly validated exchanged token and later refresh rotation without hidden re-exchange", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twitch-finish-"));
    const pendingPath = join(dir, "pending.json");
    const path = join(dir, "credentials/token.json");
    const fresh = {
      ...token,
      refreshToken: "new-device-refresh",
      obtainmentTimestamp: 10,
    };
    const transport: OAuthTransport = {
      start: vi.fn(),
      exchange: vi.fn().mockResolvedValue(fresh),
      validate: vi.fn().mockResolvedValue({
        clientId: "testclient",
        userId: "123",
        scopes: [...SCOPES],
        expiresIn: 3599,
      }),
    };
    try {
      privateJson(pendingPath, { ...pending, nextPollAt: 0 });
      expect(
        await finishAuthorization(pendingPath, "testclient", path, {
          now: () => 10,
          transport,
        }),
      ).toBe("123");
      expect(transport.exchange).toHaveBeenCalledTimes(1);
      expect(transport.validate).toHaveBeenCalledWith(
        fresh.accessToken,
        expect.any(AbortSignal),
      );
      expect(readToken(path).token).toEqual({ ...fresh, scope: [...SCOPES] });
      expect(existsSync(pendingPath)).toBe(false);
      const provider = createAuth(readToken(path), path);
      const rotated = {
        ...fresh,
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
      };
      Reflect.apply(Reflect.get(provider, "emit"), provider, [
        provider.onRefresh,
        "123",
        rotated,
      ]);
      expect(readToken(path).token).toEqual(rotated);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses mismatched clients or incomplete scopes before saving tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twitch-invalid-"));
    try {
      for (const validation of [
        {
          clientId: "other",
          userId: "123",
          scopes: [...SCOPES],
          expiresIn: 3600,
        },
        {
          clientId: "testclient",
          userId: "123",
          scopes: ["user:read:chat"],
          expiresIn: 3600,
        },
      ]) {
        const pendingPath = join(dir, "pending.json");
        const path = join(dir, "tokens.json");
        privateJson(pendingPath, { ...pending, nextPollAt: 0 });
        const transport: OAuthTransport = {
          start: vi.fn(),
          exchange: vi.fn().mockResolvedValue(token),
          validate: vi.fn().mockResolvedValue(validation),
        };
        await expect(
          finishAuthorization(pendingPath, "testclient", path, {
            now: () => 10,
            transport,
          }),
        ).rejects.toThrow("identity or granted scopes");
        expect(existsSync(path)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("aborts hanging token validation before persisting credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twitch-validation-"));
    const pendingPath = join(dir, "pending.json");
    const path = join(dir, "tokens.json");
    let received: AbortSignal | undefined;
    try {
      privateJson(pendingPath, { ...pending, nextPollAt: 0 });
      const transport: OAuthTransport = {
        start: vi.fn(),
        exchange: vi.fn().mockResolvedValue(token),
        validate: async (_accessToken, signal) =>
          new Promise((_resolve, reject) => {
            received = signal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      };
      await expect(
        finishAuthorization(pendingPath, "testclient", path, {
          now: () => 10,
          transport,
          requestTimeoutMs: 20,
        }),
      ).rejects.toThrow("deadline");
      expect(received?.aborted).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(pendingPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
