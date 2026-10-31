export type RewardCapability =
  | { path: "app-owned"; rewardId: string; refundable: true }
  | { path: "dashboard-consume-only"; rewardId: string; refundable: false };

export const BREAK_REWARD = { title: "Break the game", cost: 100 } as const;
export interface LiveRewards {
  setup(options?: { dryRun?: boolean }): Promise<RewardCapability | null>;
  settle(
    capability: RewardCapability,
    redemptionId: string,
    status: "FULFILLED" | "CANCELED",
  ): Promise<void>;
}

/** Logs complete response bodies only to the caller's private recorder. Credentials
 * remain in headers, and a provider reflecting the access token is redacted.
 * https://dev.twitch.tv/docs/api/reference/#update-redemption-status
 * Only the creating application can update a redemption, including fulfillment. */
export function createLiveRewards(options: {
  clientId: string;
  broadcasterId: string;
  accessToken(): Promise<string>;
  record(event: Record<string, unknown>): void;
  fetch?: typeof fetch;
}): LiveRewards {
  const fetcher = options.fetch ?? fetch;
  async function request(
    method: "GET" | "POST" | "PATCH",
    suffix = "",
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }> {
    const token = await options.accessToken();
    const response = await fetcher(
      `https://api.twitch.tv/helix/channel_points/custom_rewards${suffix}?${new URLSearchParams({ broadcaster_id: options.broadcasterId, ...query })}`,
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
    const raw = await response.text();
    options.record({
      type: "twitch.reward-response",
      method,
      endpoint: `channel_points/custom_rewards${suffix}`,
      status: response.status,
      body: raw.replaceAll(token, "[redacted]"),
    });
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        "Invalid Twitch reward response; inspect private reward-response log.",
      );
    }
    return { status: response.status, data };
  }
  const rows = (data: unknown): Record<string, unknown>[] => {
    if (
      !data ||
      typeof data !== "object" ||
      !("data" in data) ||
      !Array.isArray(data.data)
    )
      throw new Error("Invalid Twitch reward data.");
    return data.data.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object" && !Array.isArray(row),
    );
  };
  const matching = (data: unknown) =>
    rows(data).filter(
      (row) =>
        row.title === BREAK_REWARD.title &&
        row.cost === BREAK_REWARD.cost &&
        row.is_user_input_required === false &&
        row.is_enabled === true &&
        row.is_paused === false &&
        row.is_in_stock === true &&
        typeof row.id === "string" &&
        row.id.length > 0,
    );
  return {
    async setup({ dryRun = false } = {}) {
      try {
        const created = dryRun
          ? null
          : await request(
              "POST",
              "",
              {},
              {
                ...BREAK_REWARD,
                is_user_input_required: false,
                should_redemptions_skip_request_queue: false,
              },
            );
        let capability: RewardCapability;
        if (created?.status === 200) {
          const reward = matching(created.data)[0];
          if (!reward || typeof reward.id !== "string")
            throw new Error("Invalid created reward.");
          capability = {
            path: "app-owned",
            rewardId: reward.id,
            refundable: true,
          };
        } else {
          if (created && created.status !== 403 && created.status !== 400)
            throw new Error("Reward creation refused.");
          // A restart can return 400 because this app's title already exists.
          // Distinguish ownership by Twitch's own manageable-rewards filter.
          let appOwned = created?.status === 400 || dryRun;
          let listed = await request(
            "GET",
            "",
            created?.status === 400 || dryRun
              ? { only_manageable_rewards: "true" }
              : {},
          );
          if (
            appOwned &&
            listed.status === 200 &&
            matching(listed.data).length === 0
          ) {
            listed = await request("GET");
            appOwned = false;
          }
          if (listed.status !== 200)
            throw new Error("Reward discovery refused.");
          const matches = matching(listed.data);
          if (matches.length !== 1)
            throw new Error(
              "Create exactly one enabled dashboard reward named Break the game, cost 100, without user input.",
            );
          const id = matches[0]?.id;
          if (typeof id !== "string") throw new Error("Invalid reward ID.");
          capability = appOwned
            ? { path: "app-owned", rewardId: id, refundable: true }
            : {
                path: "dashboard-consume-only",
                rewardId: id,
                refundable: false,
              };
        }
        options.record({ type: "twitch.reward-ready", ...capability, dryRun });
        return capability;
      } catch {
        options.record({
          type: "twitch.reward-unavailable",
          instruction:
            "Channel Points disabled. Inspect private reward-response logs; create an enabled dashboard reward Break the game, cost 100, no user input. Chat !break remains available.",
        });
        return null;
      }
    },
    async settle(capability, redemptionId, status) {
      if (capability.path !== "app-owned")
        throw new Error(
          "Dashboard rewards require manual settlement by the broadcaster.",
        );
      const response = await request(
        "PATCH",
        "/redemptions",
        {
          reward_id: capability.rewardId,
          id: redemptionId,
        },
        { status },
      );
      if (response.status !== 200)
        throw new Error(
          "Reward settlement refused; inspect private reward-response log.",
        );
      const updated = rows(response.data).find(
        (row) => row.id === redemptionId && row.status === status,
      );
      if (!updated)
        throw new Error("Twitch did not confirm reward settlement.");
      options.record({
        type: "twitch.reward-settled",
        rewardId: capability.rewardId,
        redemptionId,
        status,
      });
    },
  };
}

/** Capability probe is explicit; no dashboard reward can be refunded by this app. */
export async function chooseReward(options: {
  create: () => Promise<{ id: string }>;
  dashboardRewardId?: string;
  log: (capability: RewardCapability) => void;
}): Promise<RewardCapability> {
  let result: RewardCapability;
  try {
    result = {
      path: "app-owned",
      rewardId: (await options.create()).id,
      refundable: true,
    };
  } catch (error) {
    const status =
      error && typeof error === "object" && "statusCode" in error
        ? error.statusCode
        : undefined;
    if (status !== 403)
      throw new Error(
        "Reward setup failed. The application has not selected a reward path.",
      );
    if (!options.dashboardRewardId)
      throw new Error(
        "Reward creation is unavailable. Configure a dashboard reward ID for consume-only mode.",
      );
    result = {
      path: "dashboard-consume-only",
      rewardId: options.dashboardRewardId,
      refundable: false,
    };
  }
  options.log(result);
  return result;
}
