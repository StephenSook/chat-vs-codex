import { afterEach, expect, it, vi } from "vitest";
import { startPanelLifecycle } from "../src/lifecycle.js";

afterEach(() => vi.useRealTimers());
it("pauses for BFCache, resumes one redraw timer and disconnects exactly once on normal unload", () => {
  vi.useFakeTimers();
  const page = new EventTarget();
  const draw = vi.fn();
  const disconnect = vi.fn();
  const close = startPanelLifecycle({
    page: page as unknown as Pick<
      Window,
      "addEventListener" | "removeEventListener"
    >,
    draw,
    visible: () => true,
    disconnect,
  });
  const transition = (type: string, persisted: boolean) => {
    const event = new Event(type);
    Object.defineProperty(event, "persisted", { value: persisted });
    page.dispatchEvent(event);
  };
  expect(draw).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(250);
  expect(draw).toHaveBeenCalledTimes(2);
  transition("pagehide", true);
  vi.advanceTimersByTime(1000);
  expect(draw).toHaveBeenCalledTimes(2);
  expect(disconnect).not.toHaveBeenCalled();
  transition("pageshow", true);
  transition("pageshow", true);
  expect(draw).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(500);
  expect(draw).toHaveBeenCalledTimes(6);
  transition("pagehide", false);
  expect(disconnect).toHaveBeenCalledTimes(1);
  const count = draw.mock.calls.length;
  transition("pageshow", true);
  vi.advanceTimersByTime(1000);
  close();
  expect(draw).toHaveBeenCalledTimes(count);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
