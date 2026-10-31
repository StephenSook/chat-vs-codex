import { describe, expect, it, vi } from "vitest";
import { createLiveRewards, type RewardCapability } from "../src/rewards.js";

const reward = {
  id: "break-reward",
  title: "Break the game",
  cost: 100,
  is_user_input_required: false,
  is_enabled: true,
  is_paused: false,
  is_in_stock: true,
};
function setup(responses: { status: number; body: unknown }[]) {
  const logs: Record<string, unknown>[] = [];
  const request = vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  const api = createLiveRewards({
    clientId: "app",
    broadcasterId: "channel",
    accessToken: async () => "private-token",
    fetch: request,
    record: (event) => logs.push(event),
  });
  return { api, logs, request };
}
const owned: RewardCapability = {
  path: "app-owned",
  rewardId: reward.id,
  refundable: true,
};
describe("live Channel Points transport", () => {
  it("creates the fixed no-input queued reward and records the exact provider response", async () => {
    const body = { data: [reward], extra: "retained" };
    const { api, request, logs } = setup([{ status: 200, body }]);
    expect(await api.setup()).toEqual(owned);
    const [input, init] = request.mock.calls[0] ?? [];
    expect(String(input)).toContain("broadcaster_id=channel");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Break the game",
      cost: 100,
      is_user_input_required: false,
      should_redemptions_skip_request_queue: false,
    });
    expect(logs[0]).toMatchObject({ status: 200, body: JSON.stringify(body) });
    expect(JSON.stringify(logs)).not.toContain("private-token");
  });
  it.each(["not affiliate", "app restriction", "missing scope"])(
    "discovers dashboard reward on any HTTP403: %s",
    async (message) => {
      const { api, request, logs } = setup([
        { status: 403, body: { message } },
        {
          status: 200,
          body: {
            data: [{ ...reward, id: "unrelated", title: "Other" }, reward],
          },
        },
      ]);
      expect(await api.setup()).toEqual({
        path: "dashboard-consume-only",
        rewardId: reward.id,
        refundable: false,
      });
      expect(request.mock.calls[1]?.[1]?.method).toBe("GET");
      expect(String(request.mock.calls[1]?.[0])).not.toContain(
        "only_manageable_rewards",
      );
      expect(logs[0]).toMatchObject({
        status: 403,
        body: JSON.stringify({ message }),
      });
    },
  );
  it("reuses a reward on restart only when Twitch confirms app ownership", async () => {
    const { api, request } = setup([
      { status: 400, body: { message: "title exists" } },
      { status: 200, body: { data: [reward] } },
    ]);
    expect(await api.setup()).toEqual(owned);
    expect(String(request.mock.calls[1]?.[0])).toContain(
      "only_manageable_rewards=true",
    );
  });
  it("keeps chat usable when Channel Points are unavailable, ambiguous or incompatible", async () => {
    for (const data of [
      [],
      [reward, { ...reward, id: "duplicate" }],
      [{ ...reward, cost: 500 }],
      [{ ...reward, is_user_input_required: true }],
    ]) {
      const { api, logs } = setup([
        { status: 403, body: { message: "unavailable" } },
        { status: 200, body: { data } },
      ]);
      expect(await api.setup()).toBeNull();
      expect(logs.at(-1)).toMatchObject({ type: "twitch.reward-unavailable" });
    }
  });
  it("redacts reflected access tokens without truncating refusal bodies", async () => {
    const message = `private-token ${"x".repeat(600)}`;
    const { api, logs } = setup([{ status: 500, body: { message } }]);
    expect(await api.setup()).toBeNull();
    expect(logs[0]?.body).toBe(
      JSON.stringify({ message }).replace("private-token", "[redacted]"),
    );
  });
  it("dry chat performs discovery only, with no reward writes", async () => {
    const { api, request } = setup([{ status: 200, body: { data: [reward] } }]);
    expect(await api.setup({ dryRun: true })).toEqual(owned);
    expect(request.mock.calls.map((call) => call[1]?.method)).toEqual(["GET"]);
  });
  it.each([true, false])(
    "discovers dashboard rewards after an empty ownership query, dry run=%s",
    async (dryRun) => {
      const { api, request } = setup([
        ...(dryRun
          ? []
          : [{ status: 400, body: { message: "title already exists" } }]),
        { status: 200, body: { data: [] } },
        { status: 200, body: { data: [reward] } },
      ]);
      expect(await api.setup({ dryRun })).toEqual({
        path: "dashboard-consume-only",
        rewardId: reward.id,
        refundable: false,
      });
      const gets = request.mock.calls.filter(
        (call) => call[1]?.method === "GET",
      );
      expect(String(gets[0]?.[0])).toContain("only_manageable_rewards=true");
      expect(String(gets[1]?.[0])).not.toContain("only_manageable_rewards");
    },
  );
  it.each(["FULFILLED", "CANCELED"] as const)(
    "updates only owned rewards and verifies Twitch confirmed %s",
    async (status) => {
      const { api, request, logs } = setup([
        { status: 200, body: { data: [{ id: "redeem", status }] } },
      ]);
      await api.settle(owned, "redeem", status);
      expect(request.mock.calls[0]?.[1]?.method).toBe("PATCH");
      expect(String(request.mock.calls[0]?.[0])).toContain("/redemptions?");
      expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
        status,
      });
      expect(logs.at(-1)).toMatchObject({
        type: "twitch.reward-settled",
        status,
      });
    },
  );
  it("cannot send a dashboard reward settlement request", async () => {
    const { api, request } = setup([]);
    await expect(
      api.settle(
        {
          path: "dashboard-consume-only",
          rewardId: reward.id,
          refundable: false,
        },
        "redeem",
        "FULFILLED",
      ),
    ).rejects.toThrow("manual settlement");
    expect(request).not.toHaveBeenCalled();
  });
  it("never claims fulfillment on a refused or mismatched update", async () => {
    for (const response of [
      { status: 403, body: { message: "wrong app" } },
      { status: 200, body: { data: [{ id: "other", status: "FULFILLED" }] } },
    ]) {
      const { api, logs } = setup([response]);
      await expect(api.settle(owned, "redeem", "FULFILLED")).rejects.toThrow();
      expect(logs.some((event) => event.type === "twitch.reward-settled")).toBe(
        false,
      );
    }
  });
});
