import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAuth,
  privateJson,
  readToken,
  SCOPES,
  type StoredToken,
} from "../src/auth.js";
import { createOAuthTransport } from "../src/auth-transport.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "public-refresh-"));
  directories.push(directory);
  const path = join(directory, "twitch/tokens.json");
  const stored: StoredToken = {
    clientId: "publicclient",
    userId: "123",
    token: {
      accessToken: "expired-access",
      refreshToken: "refresh+with/&=symbols",
      scope: [...SCOPES],
      expiresIn: 1,
      obtainmentTimestamp: 0,
    },
  };
  privateJson(path, stored);
  return { path, stored };
}
const fresh = (refresh = "rotated-refresh") => ({
  access_token: "fresh-access",
  refresh_token: refresh,
  scope: [...SCOPES],
  expires_in: 3600,
});
const valid = () => ({
  client_id: "publicclient",
  user_id: "123",
  scopes: [...SCOPES],
  expires_in: 3599,
});

it("automatically refreshes an expired public device token, persists rotation at0600 before validation and encodes the form without a secret", async () => {
  const { path, stored } = fixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url, init) => {
      if (String(url).endsWith("/token")) return Response.json(fresh());
      expect(readToken(path).token.refreshToken).toBe("rotated-refresh");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(init?.headers).toEqual({ Authorization: "OAuth fresh-access" });
      return Response.json(valid());
    });
  const provider = createAuth(stored, path, {
    transport: createOAuthTransport(fetcher),
  });
  expect(
    (await provider.getAccessTokenForUser("123", [...SCOPES]))?.accessToken,
  ).toBe("fresh-access");
  const form = new URLSearchParams(
    fetcher.mock.calls[0]?.[1]?.body?.toString(),
  );
  expect(Object.fromEntries(form)).toEqual({
    client_id: "publicclient",
    grant_type: "refresh_token",
    refresh_token: stored.token.refreshToken,
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://id.twitch.tv/oauth2/token");
  expect(readToken(path).token.refreshToken).toBe("rotated-refresh");
  expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
});

it("shares one in-flight refresh and uses the rotated refresh token on the next explicit401 refresh", async () => {
  const { path, stored } = fixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fresh("rotation-one")))
    .mockResolvedValueOnce(Response.json(valid()))
    .mockResolvedValueOnce(Response.json(fresh("rotation-two")))
    .mockResolvedValueOnce(Response.json(valid()));
  const provider = createAuth(stored, path, {
    transport: createOAuthTransport(fetcher),
  });
  const [a, b] = await Promise.all([
    provider.refreshAccessTokenForUser("123"),
    provider.refreshAccessTokenForUser("123"),
  ]);
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await provider.refreshAccessTokenForUser("123");
  const form = new URLSearchParams(
    fetcher.mock.calls[2]?.[1]?.body?.toString(),
  );
  expect(form.get("refresh_token")).toBe("rotation-one");
  expect(readToken(path).token.refreshToken).toBe("rotation-two");
});

it("fails loudly with re-auth instructions on rejection, redacts remote errors, preserves old credentials and never retries the consumed operation", async () => {
  const { path, stored } = fixture();
  const before = readFileSync(path, "utf8");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        message: "rejected expired-access refresh+with/&=symbols",
        access_token: "remote-secret",
      },
      { status: 400 },
    ),
  );
  const provider = createAuth(stored, path, {
    transport: createOAuthTransport(fetcher),
  });
  const failed = vi.fn();
  provider.onRefreshFailure(failed);
  await expect(provider.refreshAccessTokenForUser("123")).rejects.toThrow(
    "auth start",
  );
  await expect(provider.refreshAccessTokenForUser("123")).rejects.toThrow(
    "auth resume",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledOnce();
  expect(String(failed.mock.calls[0]?.[1])).not.toMatch(
    /remote-secret|expired-access|symbols/,
  );
  expect(readFileSync(path, "utf8")).toBe(before);
});

it("retains the rotated refresh token if post-refresh identity validation fails", async () => {
  const { path, stored } = fixture();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fresh()))
    .mockResolvedValueOnce(
      Response.json({ ...valid(), user_id: "wrong-user" }),
    );
  const provider = createAuth(stored, path, {
    transport: createOAuthTransport(fetcher),
  });
  await expect(provider.refreshAccessTokenForUser("123")).rejects.toThrow(
    "Re-authorize",
  );
  expect(readToken(path).token.refreshToken).toBe("rotated-refresh");
});

it("aborts a hanging refresh and refuses a missing refresh token without disclosing credentials", async () => {
  vi.useFakeTimers();
  const { path, stored } = fixture();
  let signal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener(
        "abort",
        () => reject(new Error("unsafe network details")),
        { once: true },
      );
    });
  const provider = createAuth(stored, path, {
    transport: createOAuthTransport(fetcher),
    requestTimeoutMs: 50,
  });
  const rejected = expect(
    provider.refreshAccessTokenForUser("123"),
  ).rejects.toThrow("Re-authorize");
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(() =>
    createAuth(
      { ...stored, token: { ...stored.token, refreshToken: null } },
      path,
    ),
  ).toThrow("Re-authorize");
});
