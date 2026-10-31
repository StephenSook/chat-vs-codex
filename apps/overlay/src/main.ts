import "@fontsource/baloo-2/latin-800.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/bungee/latin-400.css";
import "./style.css";
import { INPUT } from "@chat-vs-codex/sim";
import { connectRoundBridge } from "./bridge.js";
import {
  createEventBus,
  headStartSeconds,
  initialBroadcast,
  type OverlayEventBus,
  reduceBroadcast,
} from "./events.js";
import { type GhostView, RecordedGhost } from "./ghost.js";
import { element, renderBroadcast, renderClock, resizeStage } from "./hud.js";
import {
  type CameraMode,
  type cameraFor,
  corruptionFor,
  playfieldCamera,
} from "./presentation.js";
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
        camera: ReturnType<typeof cameraFor>;
        corruption: ReturnType<typeof corruptionFor>;
        ghost: ReturnType<RecordedGhost["snapshot"]>;
      };
    };
  }
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const bridgeUrl = params.get("bridge");
  const mode = bridgeUrl || params.get("mode") === "play" ? "play" : "replay";
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const cameraMode: CameraMode =
    params.get("camera") === "overview" ? "overview" : "follow";
  const simulation = new SimulationPlayer(mode);
  const events = createEventBus();
  const ghost = new RecordedGhost();
  let broadcast = initialBroadcast();
  let input = 0;
  let lastCountdown: number | null = null;
  let lastRunStatus = "";
  let bridgeError: string | null = null;
  let validating = false;
  let renderedGhost: GhostView | null = null;
  resizeStage();
  window.addEventListener("resize", resizeStage);
  renderBroadcast(broadcast);
  element("controls").textContent =
    mode === "play" ? "← → MOVE · SPACE JUMP · R RESTART" : "";
  element("playback-label").textContent = bridgeUrl
    ? "LOCAL ROUND"
    : mode === "play"
      ? "FREE PLAY"
      : "CLEAN REPLAY";
  if (mode === "play") element("round-label").textContent = "FREE PLAY";

  const unsubscribe = events.subscribe((event) => {
    broadcast = reduceBroadcast(broadcast, event);
    ghost.observe(event);
    renderBroadcast(broadcast);
    if (!broadcast.roundId && mode === "play")
      element("round-label").textContent = "FREE PLAY";
    renderClock(broadcast, performance.now());
  });
  const scene = await createScene(element("game"), cameraMode);
  window.chatVsCodex = {
    events,
    snapshot: () => ({
      frame: simulation.state.frame,
      hash: simulation.hash(),
      mode,
      filtersEnabled: !motion.matches,
      camera: playfieldCamera(
        simulation.state,
        cameraMode,
        renderedGhost,
        validating,
      ),
      corruption: corruptionFor(broadcast, performance.now(), motion.matches),
      ghost: ghost.snapshot(),
    }),
  };
  const disconnectBridge = bridgeUrl
    ? connectRoundBridge(bridgeUrl, {
        simulation,
        events,
        onError(error) {
          bridgeError = error.message;
          element("run-status").title = error.message;
          console.error(error);
        },
        onConnection(connected) {
          if (
            connected &&
            bridgeError === "Round connection lost; reconnecting"
          )
            bridgeError = null;
        },
        onState(state) {
          validating = state.phase === "validating";
          if (state.phase === "preparing") bridgeError = null;
          if (state.phase === "rolled-back") ghost.clear();
        },
        onBuild(build) {
          if (build.phase === "rollback") ghost.clear();
        },
      })
    : () => {};

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
    const corruption = corruptionFor(broadcast, nowMs, motion.matches);
    element("game").dataset.corruption = corruption.treatment;
    renderedGhost = ghost.advance(ticker.elapsedMS, motion.matches);
    scene.draw(simulation.state, corruption, renderedGhost, validating);
    const countdown = headStartSeconds(broadcast, nowMs);
    if (countdown !== lastCountdown) {
      lastCountdown = countdown;
      renderClock(broadcast, nowMs);
    }
    const status = bridgeError
      ? "ROUND DISCONNECTED"
      : !simulation.state.alive
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
      disconnectBridge();
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
