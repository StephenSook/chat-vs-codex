import "@fontsource/baloo-2/latin-800.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/bungee/latin-400.css";
import "./style.css";
import { hashState, INPUT } from "@chat-vs-codex/sim";
import {
  createEventBus,
  headStartSeconds,
  initialBroadcast,
  type OverlayEventBus,
  reduceBroadcast,
} from "./events.js";
import { element, renderBroadcast, renderClock, resizeStage } from "./hud.js";
import { createScene } from "./scene.js";
import { SimulationPlayer } from "./simulation.js";

declare global {
  interface Window {
    chatVsCodex: {
      events: OverlayEventBus;
      snapshot: () => {
        frame: number;
        hash: string;
        mode: "play" | "replay";
        filtersEnabled: boolean;
      };
    };
  }
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "play" ? "play" : "replay";
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const experimentalFilters = params.get("filters") === "1" && !motion.matches;
  const simulation = new SimulationPlayer(mode);
  const events = createEventBus();
  let broadcast = initialBroadcast();
  let burstUntilMs = 0;
  let input = 0;
  let lastCountdown: number | null = null;
  let lastRunStatus = "";
  resizeStage();
  window.addEventListener("resize", resizeStage);
  renderBroadcast(broadcast);
  element("controls").textContent =
    mode === "play" ? "← → MOVE · SPACE JUMP · R RESTART" : "";
  element("playback-label").textContent =
    mode === "play" ? "FREE PLAY" : "CLEAN REPLAY";
  if (mode === "play") element("round-label").textContent = "FREE PLAY";

  const unsubscribe = events.subscribe((event) => {
    broadcast = reduceBroadcast(broadcast, event);
    if (
      event.type === "bug.active" &&
      broadcast.roundId === event.roundId &&
      broadcast.bug === "active"
    ) {
      burstUntilMs = performance.now() + 500;
    }
    renderBroadcast(broadcast);
    if (!broadcast.roundId && mode === "play")
      element("round-label").textContent = "FREE PLAY";
    renderClock(broadcast, performance.now());
  });
  const scene = await createScene(element("game"), experimentalFilters);
  window.chatVsCodex = {
    events,
    snapshot: () => ({
      frame: simulation.state.frame,
      hash: hashState(simulation.state),
      mode,
      filtersEnabled: experimentalFilters,
    }),
  };

  function key(event: KeyboardEvent): void {
    if (mode !== "play") return;
    const mask =
      event.code === "ArrowLeft"
        ? INPUT.LEFT
        : event.code === "ArrowRight"
          ? INPUT.RIGHT
          : event.code === "Space"
            ? INPUT.JUMP
            : 0;
    if (mask) {
      event.preventDefault();
      input = event.type === "keydown" ? input | mask : input & ~mask;
    }
    if (event.type === "keydown" && event.code === "KeyR" && !event.repeat)
      simulation.reset();
  }
  window.addEventListener("keydown", key);
  window.addEventListener("keyup", key);
  const clearInput = () => {
    input = 0;
  };
  window.addEventListener("blur", clearInput);
  const visibility = () => {
    if (document.hidden) clearInput();
  };
  document.addEventListener("visibilitychange", visibility);

  scene.app.ticker.maxFPS = 60;
  scene.app.ticker.add((ticker) => {
    const result = simulation.advance(ticker.elapsedMS, input);
    for (let death = 0; death < result.deaths; death++)
      events.publish({ type: "simulation.death" });
    const nowMs = performance.now();
    const intensity =
      !motion.matches && nowMs < burstUntilMs ? broadcast.intensity : 0;
    scene.draw(simulation.state, intensity);
    const countdown = headStartSeconds(broadcast, nowMs);
    if (countdown !== lastCountdown) {
      lastCountdown = countdown;
      renderClock(broadcast, nowMs);
    }
    const status = !simulation.state.alive
      ? "ϟ YOU DIED"
      : simulation.state.won
        ? "✓ FLAG REACHED"
        : "RUNNING";
    if (lastRunStatus !== status) {
      element("run-status").textContent = status;
      lastRunStatus = status;
    }
  });
  scene.app.ticker.start();

  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      window.removeEventListener("resize", resizeStage);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", clearInput);
      document.removeEventListener("visibilitychange", visibility);
      scene.destroy();
    },
    { once: true },
  );
}

start().catch((error: unknown) => {
  element("run-status").textContent = "RENDER UNAVAILABLE";
  console.error(error);
});
