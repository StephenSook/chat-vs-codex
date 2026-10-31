export type RewardCapability =
  | { path: "app-owned"; rewardId: string; refundable: true }
  | { path: "dashboard-consume-only"; rewardId: string; refundable: false };

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
    const body =
      error && typeof error === "object" && "body" in error ? error.body : "";
    if (
      status !== 403 ||
      typeof body !== "string" ||
      !/not a partner or affiliate/i.test(body)
    )
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
