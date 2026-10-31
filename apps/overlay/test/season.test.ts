import { afterEach, expect, it, vi } from "vitest";
import {
  deriveSeason,
  type SeasonReceipt,
} from "../../../packages/round/src/season.js";
import { connectRoundBridge } from "../src/bridge.js";
import { createEventBus } from "../src/events.js";
import { SimulationPlayer } from "../src/simulation.js";

afterEach(() => vi.unstubAllGlobals());
it("delivers validated viewer season updates through the actual SSE bridge without round-score events", () => {
  const listeners = new Map<string, (message: { data: string }) => void>();
  const close = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener(
        type: string,
        listener: (message: { data: string }) => void,
      ) {
        listeners.set(type, listener);
      }
      close = close;
    },
  );
  const onSeason = vi.fn();
  const onError = vi.fn();
  const events = createEventBus();
  const observed = vi.fn();
  events.subscribe(observed);
  const disconnect = connectRoundBridge("http://127.0.0.1:4179", {
    simulation: new SimulationPlayer("play"),
    events,
    onSeason,
    onError,
  });
  const row: SeasonReceipt = {
    roundId: "viewer",
    mode: "live-twitch",
    input: "chat",
    winner: "chat",
    autopsy: null,
    events: [],
  };
  const totals = deriveSeason([row]).viewers;
  listeners.get("season")?.({ data: JSON.stringify(totals) });
  expect(onSeason).toHaveBeenCalledWith(totals);
  expect(observed).not.toHaveBeenCalled();
  listeners.get("season")?.({
    data: JSON.stringify({ ...totals, chatWins: 999 }),
  });
  expect(onSeason).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(new Error("Invalid viewer season"));
  disconnect();
  expect(close).toHaveBeenCalledOnce();
});
