import { describe, expect, it } from "vitest";
import type { RoundEnvelope } from "../../../packages/round/src/contracts.js";
import { PublicRoundProjection } from "../../../packages/round/src/public-state.js";
import {
  connectPanel,
  type ExtensionHelper,
  panelView,
  parsePanelMessage,
} from "../src/panel.js";

const now = Date.parse("2026-10-31T18:00:00.000Z");
const projection = () =>
  new PublicRoundProjection({
    mode: "live-twitch",
    trigger: "broadcaster-test",
  });

describe("Extension panel", () => {
  it("shows producer state and only counts down the actual head-start deadline", () => {
    const producer = projection();
    const envelope: RoundEnvelope = {
      sequence: 1,
      serverTimeMs: 1000,
      wallTime: new Date(now).toISOString(),
      event: {
        type: "round.state",
        roundId: "real-round",
        phase: "preparing",
        headStartEndsAt: null,
        winner: null,
        reason: null,
      },
    };
    producer.observe(envelope);
    producer.observe({
      ...envelope,
      event: {
        ...envelope.event,
        type: "round.state",
        roundId: "real-round",
        phase: "head-start",
        headStartEndsAt: 16000,
        winner: null,
        reason: null,
      },
    });
    const state = parsePanelMessage(
      JSON.stringify(producer.snapshot(new Date(now).toISOString())),
    );
    expect(panelView(state, now)).toMatchObject({
      label: "TEST ROUND",
      phase: "CHAT 15 s",
      step: "",
      season: "SEASON · CHAT 0 : CODEX 0",
    });
    expect(panelView(state, now + 5000).phase).toBe("CHAT 10 s");
    expect(panelView(state, now + 11000).connection).toBe(
      "Waiting for round data",
    );
    expect(panelView(state, now - 11000).connection).toBe(
      "Waiting for round data",
    );
  });
  it("subscribes once after authorization without storing tokens or identity, and removes its exact callback", () => {
    let authorize: ((auth: { channelId: string }) => void) | undefined;
    let receive:
      | ((target: string, contentType: string, message: string) => void)
      | undefined;
    let visibility: ((visible: boolean) => void) | undefined;
    let subscriptions = 0;
    let removed = false;
    const helper: ExtensionHelper = {
      onAuthorized(callback) {
        authorize = callback;
      },
      listen(topic, callback) {
        expect(topic).toBe("broadcast");
        subscriptions++;
        receive = callback;
      },
      unlisten(topic, callback) {
        expect(topic).toBe("broadcast");
        expect(callback).toBe(receive);
        removed = true;
      },
      onVisibilityChanged(callback) {
        visibility = callback;
      },
    };
    const rendered: unknown[] = [];
    const stop = connectPanel(
      helper,
      (state) => rendered.push(state),
      () => now,
    );
    expect(subscriptions).toBe(0);
    authorize?.({ channelId: "123" });
    authorize?.({ channelId: "123" });
    expect(subscriptions).toBe(1);
    const message = JSON.stringify(
      projection().snapshot(new Date(now).toISOString()),
    );
    receive?.("broadcast", "application/json", "{invalid");
    receive?.("broadcast", "text/html", message);
    expect(rendered).toHaveLength(0);
    receive?.("broadcast", "application/json", message);
    expect(rendered).toHaveLength(1);
    visibility?.(false);
    receive?.("broadcast", "application/json", message);
    expect(rendered).toHaveLength(1);
    stop();
    expect(removed).toBe(true);
  });
  it("drops far-future and stale snapshots before advancing its ordering watermark", () => {
    let receive:
      | ((target: string, contentType: string, message: string) => void)
      | undefined;
    const helper: ExtensionHelper = {
      onAuthorized(callback) {
        callback({ channelId: "42" });
      },
      listen(_topic, callback) {
        receive = callback;
      },
      unlisten() {},
      onVisibilityChanged() {},
    };
    const rendered: unknown[] = [];
    let current = now;
    const stop = connectPanel(
      helper,
      (state) => rendered.push(state),
      () => current,
    );
    const producer = projection();
    const deliver = (time: number) =>
      receive?.(
        "broadcast",
        "application/json",
        JSON.stringify(producer.snapshot(new Date(time).toISOString())),
      );
    deliver(current + 86400000);
    deliver(current - 10001);
    expect(rendered).toHaveLength(0);
    deliver(current);
    expect(rendered).toHaveLength(1);
    deliver(current + 86400000);
    current += 1000;
    deliver(current);
    expect(rendered).toHaveLength(2);
    deliver(current - 1);
    expect(rendered).toHaveLength(2);
    stop();
  });
  it("refuses oversize/invalid payloads and strips undeclared fields before presentation", () => {
    expect(() => parsePanelMessage(" ".repeat(5001))).toThrow("Invalid");
    expect(() => parsePanelMessage('{"token":"private"}')).toThrow("Invalid");
    const state = projection().snapshot(new Date(now).toISOString());
    expect(
      parsePanelMessage(JSON.stringify({ ...state, username: "hidden" })),
    ).toEqual(state);
  });
});
