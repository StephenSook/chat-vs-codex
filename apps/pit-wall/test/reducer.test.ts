import type { ServerFrame, State } from "@chat-vs-codex/pit-wall/protocol";
import { initialState } from "@chat-vs-codex/pit-wall/protocol";
import { describe, expect, it } from "vitest";
import {
  canHint,
  canVeto,
  countdownSeconds,
  gatewayUrl,
  initialPhoneState,
  nativePayload,
  phoneReducer,
} from "../src/state";

const round = (override: Partial<State> = {}): State => ({
  ...initialState(),
  roundId: "round-7",
  number: 7,
  phase: "head-start",
  bug: "active",
  headStartEndsAt: 16_000,
  ...override,
});
const snapshot = (
  sequence: number,
  state = round(),
  serverTimeMs = 1000,
): ServerFrame => ({
  type: "state",
  sequence,
  serverTimeMs,
  state,
});
const receive = (
  frame: ServerFrame,
  state = initialPhoneState,
  receivedAt = 1_700_000_000_000,
) => phoneReducer(state, { type: "frame", frame, receivedAt });

describe("phone reducer", () => {
  it("keeps a suspended activity for native expiry and clears a foreground disconnect", () => {
    const phone = receive(snapshot(1));
    expect(nativePayload(phone, true)).toMatchObject({
      active: true,
      roundId: "round-7",
      headStartEndsAt: 1_700_000_015_000,
    });
    expect(nativePayload(phone, false)).toBeNull();
    const offline = phoneReducer(phone, {
      type: "disconnected",
      reason: "Wi-Fi lost",
    });
    expect(nativePayload(offline, false)).toBeNull();
    expect(nativePayload(offline, true)?.active).toBe(false);
  });
  it("converts a server monotonic deadline to the phone wall clock", () => {
    const phone = receive(snapshot(1));
    expect(countdownSeconds(phone, 1_700_000_000_000)).toBe(15);
    expect(countdownSeconds(phone, 1_700_000_005_500)).toBe(10);
    expect(countdownSeconds(phone, 1_700_000_019_000)).toBe(0);
    expect(
      countdownSeconds(
        receive(snapshot(2, round({ phase: "repairing" })), phone),
        1_700_000_000_000,
      ),
    ).toBe(0);
  });

  it("ignores stale sequence and backwards server-time snapshots", () => {
    const phone = receive(snapshot(3));
    expect(receive(snapshot(2, round({ chat: 40 })), phone)).toBe(phone);
    expect(receive(snapshot(3, round({ chat: 40 })), phone)).toBe(phone);
    expect(receive(snapshot(4, round({ chat: 40 }), 999), phone)).toBe(phone);
    expect(
      receive(snapshot(4, round({ chat: 1 }), 2000), phone).round?.chat,
    ).toBe(1);
  });

  it("resets the sequence after reconnect but never re-alerts the same bug", () => {
    const original = receive(snapshot(20));
    expect(original.alertRoundId).toBe("round-7");
    const disconnected = phoneReducer(original, {
      type: "disconnected",
      reason: "Lost Wi-Fi",
    });
    expect(canHint(disconnected)).toBe(false);
    expect(countdownSeconds(disconnected, 1_700_000_000_000)).toBe(0);
    const opened = phoneReducer(disconnected, { type: "opened" });
    const reconnected = receive(snapshot(0), opened);
    expect(reconnected.connection).toBe("live");
    expect(reconnected.notifiedRounds).toEqual(["round-7"]);
    expect(reconnected.alertRoundId).toBe(original.alertRoundId);
    const next = receive(
      snapshot(1, round({ roundId: "round-8", number: 8 })),
      reconnected,
    );
    expect(next.alertRoundId).toBe("round-8");
    expect(next.notifiedRounds).toEqual(["round-7", "round-8"]);
  });

  it("does not alert on an already resolved round or heartbeats", () => {
    const resolved = receive(
      snapshot(0, round({ phase: "resolved", bug: "fixed" })),
    );
    expect(resolved.alertRoundId).toBeNull();
    const active = receive(snapshot(1), resolved);
    expect(receive(snapshot(2), active).notifiedRounds).toEqual(["round-7"]);
  });

  it("allows veto only before Codex starts and hints only in their accepted phases", () => {
    const active = receive(snapshot(0));
    expect(canVeto(active)).toBe(true);
    expect(canHint(active)).toBe(true);
    const repairing = receive(
      snapshot(1, round({ phase: "repairing" })),
      active,
    );
    expect(canVeto(repairing)).toBe(false);
    expect(canHint(repairing)).toBe(false);
    for (const phase of [
      "idle",
      "validating",
      "swapping",
      "resolved",
      "rolled-back",
    ] as const) {
      const phone = receive(snapshot(2, round({ phase })), repairing);
      expect(canHint(phone)).toBe(false);
      expect(canVeto(phone)).toBe(false);
    }
  });

  it("binds pending actions and receipts to the live round and matching id", () => {
    const active = receive(snapshot(0));
    expect(
      phoneReducer(active, { type: "pending", id: "wrong", roundId: "stale" }),
    ).toBe(active);
    const pending = phoneReducer(active, {
      type: "pending",
      id: "a1",
      roundId: "round-7",
    });
    expect(canVeto(pending)).toBe(false);
    expect(
      receive(
        { type: "ack", id: "other", accepted: true, reason: "" },
        pending,
      ),
    ).toBe(pending);
    const rejected = receive(
      {
        type: "ack",
        id: "a1",
        accepted: false,
        reason: "Codex already started",
      },
      pending,
    );
    expect(rejected.pending).toBeNull();
    expect(rejected.message).toBe("Codex already started");
    const nextRound = receive(
      snapshot(1, round({ roundId: "round-8" })),
      pending,
    );
    expect(nextRound.pending).toBeNull();
    expect(
      receive({ type: "ack", id: "a1", accepted: true, reason: "" }, nextRound)
        .message,
    ).toBeNull();
  });
});

describe("LAN address entry", () => {
  it("pins the scheme and port and refuses public hosts, userinfo and arbitrary URLs", () => {
    expect(gatewayUrl("192.168.1.20")).toBe("ws://192.168.1.20:4318");
    expect(gatewayUrl("10.0.0.4")).toBe("ws://10.0.0.4:4318");
    expect(gatewayUrl("172.16.0.4")).toBe("ws://172.16.0.4:4318");
    for (const host of [
      "8.8.8.8",
      "172.32.0.1",
      "localhost",
      "ws://10.0.0.1:4317",
      "10.0.0.999",
      "x@10.0.0.1",
      "10.0.0.1/path",
      "10.0.0.1:4317",
    ])
      expect(gatewayUrl(host)).toBeNull();
  });
});
