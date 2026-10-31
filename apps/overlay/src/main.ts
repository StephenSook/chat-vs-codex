import { seasonLine } from "../../../packages/round/src/season.js";
import "@fontsource/baloo-2/latin-800.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/bungee/latin-400.css";
import "./style.css";
import { INPUT } from "@chat-vs-codex/sim";
import { type AudioStatus, OverlayAudio } from "./audio.js";
import { IdleAutopilot } from "./autopilot.js";
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
  roundSessionLabel,
} from "./presentation.js";
import { createScene } from "./scene.js";
import { SimulationPlayer } from "./simulation.js";
import { SymptomReel } from "./symptom.js";

declare global {
  interface Window {
    chatVsCodex: {
      events: OverlayEventBus;
      snapshot: () => {
        frame: number;
        hash: string;
        mode: "play" | "replay";
        autopilot: boolean;
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
  const autopilot = new IdleAutopilot();
  const playControls = "← → MOVE · SPACE JUMP · R RESTART";
  const events = createEventBus();
  const audioButton = element("audio-toggle") as HTMLButtonElement;
  const audioVolume = element("audio-volume") as HTMLInputElement;
  function renderAudio(status: AudioStatus): void {
    const label =
      !status.unlocked || status.blocked
        ? "ENABLE SOUND"
        : status.muted
          ? "UNMUTE"
          : "MUTE";
    audioButton.setAttribute("aria-label", label);
    audioButton.title = label.toLowerCase();
    audioButton.classList.toggle(
      "is-muted",
      !status.unlocked || status.blocked || status.muted,
    );
    audioButton.setAttribute(
      "aria-pressed",
      String(status.unlocked && !status.muted),
    );
    audioVolume.value = String(Math.round(status.volume * 100));
  }
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    /* OBS storage can be disabled. */
  }
  const audio = new OverlayAudio({
    createClip: (url) => new Audio(url),
    autoArm: params.get("sound") === "on",
    ...(storage ? { storage } : {}),
    onChange: renderAudio,
  });
  renderAudio(audio.snapshot());
  audioButton.addEventListener("click", () => {
    const status = audio.snapshot();
    if (!status.unlocked || status.blocked) void audio.unlock();
    else audio.setMuted(!status.muted);
  });
  audioVolume.addEventListener("input", () =>
    audio.setVolume(Number(audioVolume.value) / 100),
  );
  const ghost = new RecordedGhost();
  const symptom = new SymptomReel();
  let headStart = false;
  let broadcast = initialBroadcast();
  let input = 0;
  let lastCountdown: number | null = null;
  let lastRunStatus = "";
  let bridgeError: string | null = null;
  let validating = false;
  let renderedGhost: GhostView | null = null;
  let renderedState = simulation.state;
  let renderedSymptom: ReturnType<SymptomReel["view"]> = null;
  resizeStage();
  window.addEventListener("resize", resizeStage);
  renderBroadcast(broadcast);
  element("controls").textContent = mode === "play" ? playControls : "";
  element("playback-label").textContent = bridgeUrl
    ? "CONNECTING"
    : mode === "play"
      ? "FREE PLAY"
      : "CLEAN REPLAY";
  if (mode === "play") element("round-label").textContent = "FREE PLAY";

  const unsubscribe = events.subscribe((event) => {
    audio.observe(event);
    broadcast = reduceBroadcast(broadcast, event);
    ghost.observe(event);
    symptom.observe(event);
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
      autopilot: autopilot.active,
      filtersEnabled: !motion.matches,
      camera: playfieldCamera(
        renderedSymptom?.focus === "enemy"
          ? {
              ...renderedState,
              x: renderedState.enemy.x,
              y: renderedState.enemy.y,
            }
          : renderedState,
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
        onSeason(season) {
          element("season-line").textContent = seasonLine(season);
          renderBroadcast(broadcast);
        },
        onSession(session) {
          element("playback-label").textContent = roundSessionLabel(session);
        },
        simulation,
        events,
        onCommentary: (event) => audio.playCommentary(event.audioUrl, event.id),
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
          audio.observeState(state);
          validating = state.phase === "validating";
          headStart = state.phase === "head-start";
          if (state.phase === "preparing") bridgeError = null;
          if (state.phase === "rolled-back") ghost.clear();
        },
        onBuild(build) {
          audio.observeBuild(build);
          if (build.phase === "rollback") ghost.clear();
        },
      })
    : () => {};

  function key(event: KeyboardEvent): void {
    if (mode !== "play") return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("button,input,select,textarea,[contenteditable]")
    ) {
      input = 0;
      return;
    }
    const mask =
      event.code === "ArrowLeft"
        ? INPUT.LEFT
        : event.code === "ArrowRight"
          ? INPUT.RIGHT
          : event.code === "Space"
            ? INPUT.JUMP
            : 0;
    if (event.type === "keydown" || mask || event.code === "KeyR") {
      autopilot.takeOver();
      element("controls").textContent = playControls;
    }
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
    if (input !== 0) autopilot.takeOver();
    input = 0;
  };
  window.addEventListener("blur", clearInput);
  element("audio-controls").addEventListener("focusin", clearInput);
  const visibility = () => {
    if (document.hidden) clearInput();
  };
  document.addEventListener("visibilitychange", visibility);

  scene.app.ticker.maxFPS = 60;
  scene.app.ticker.add((ticker) => {
    const result = autopilot.advance(simulation, ticker.elapsedMS, input);
    element("controls").textContent =
      mode === "play" ? (autopilot.active ? "AUTOPILOT" : playControls) : "";
    for (let death = 0; death < result.deaths; death++)
      events.publish({ type: "simulation.death" });
    const nowMs = performance.now();
    const corruption = corruptionFor(broadcast, nowMs, motion.matches);
    element("game").dataset.corruption = corruption.treatment;
    renderedGhost = ghost.advance(ticker.elapsedMS, motion.matches);
    const reel = symptom.view(
      nowMs,
      headStart,
      simulation.state,
      motion.matches,
    );
    renderedSymptom = reel;
    renderedState = reel?.state ?? simulation.state;
    scene.draw(
      reel?.state ?? simulation.state,
      corruption,
      renderedGhost,
      validating,
      reel?.focus ?? null,
    );
    const countdown = headStartSeconds(broadcast, nowMs);
    if (countdown !== lastCountdown) {
      lastCountdown = countdown;
      renderClock(broadcast, nowMs);
    }
    const status = bridgeError
      ? "ROUND DISCONNECTED"
      : reel
        ? "FAILING REPLAY · LOOP"
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
      audio.stop();
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
