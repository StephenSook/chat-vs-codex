import { afterEach, expect, it, vi } from "vitest";
import { resizeStage } from "../src/hud.js";

afterEach(() => vi.unstubAllGlobals());

it.each([
  [1920, 1080, 1],
  [1280, 720, 2 / 3],
  [1280, 1080, 2 / 3],
  [1920, 720, 2 / 3],
])(
  "keeps the OBS fallback fitted to %sx%s without overriding viewport CSS",
  (width, height, scale) => {
    const style = { setProperty: vi.fn(), transform: "" };
    vi.stubGlobal("window", { innerWidth: width, innerHeight: height });
    vi.stubGlobal("document", { getElementById: () => ({ style }) });
    resizeStage();
    expect(style.setProperty).toHaveBeenCalledExactlyOnceWith(
      "--fallback-stage-scale",
      String(scale),
    );
    expect(style.transform).toBe("");
  },
);
