import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createContext, SourceTextModule } from "node:vm";
import {
  initialBroadcast,
  reduceBroadcast,
} from "../../../apps/overlay/src/events.js";
import { SimulationPlayer } from "../../../apps/overlay/src/simulation.js";
import { CANARY } from "../../replay/src/index.js";
import type { GameArtifact, RoundEnvelope } from "./contracts.js";

const player = new SimulationPlayer("play");
let broadcast = initialBroadcast();
let buildId: string | null = null;
let lastTime = performance.now();
let sdkSteps = 0;
const installs: { buildId: string; frame: number; statePreserved: boolean }[] =
  [];
const clock = setInterval(() => {
  const now = performance.now();
  player.advance(
    now - lastTime,
    CANARY.inputs[player.state.frame % CANARY.inputs.length] ?? 0,
  );
  lastTime = now;
}, 1000 / 60);
const lines = createInterface({ input: process.stdin });
let queue = Promise.resolve();
lines.on("line", (line) => {
  queue = queue.then(async () => {
    let id: unknown;
    try {
      const command = JSON.parse(line) as {
        id: number;
        kind: string;
        artifact?: GameArtifact;
        envelope?: RoundEnvelope;
      };
      id = command.id;
      if (command.kind === "install" && command.artifact) {
        const artifact = command.artifact;
        if (
          artifact.id !== artifact.digest ||
          createHash("sha256").update(artifact.code).digest("hex") !==
            artifact.digest
        )
          throw new Error("Build digest mismatch");
        const module = new SourceTextModule(artifact.code, {
          context: createContext(
            {},
            { codeGeneration: { strings: false, wasm: false } },
          ),
        });
        await module.link(() => {
          throw new Error("Game bundle has an external import");
        });
        await module.evaluate({ timeout: 1000 });
        const before = player.state;
        const bytes = JSON.stringify(before);
        player.install(module.namespace);
        const preserved =
          before === player.state && bytes === JSON.stringify(player.state);
        if (!preserved) throw new Error("Hot swap reset or changed live state");
        buildId = artifact.id;
        installs.push({
          buildId,
          frame: player.state.frame,
          statePreserved: preserved,
        });
      } else if (
        command.kind === "event" &&
        command.envelope?.event.type === "round.state" &&
        command.envelope.event.phase === "preparing" &&
        command.envelope.event.roundId !== null
      ) {
        broadcast = reduceBroadcast(broadcast, {
          type: "round.preparing",
          id: command.envelope.event.roundId,
        });
      } else if (
        command.kind === "event" &&
        command.envelope?.event.type === "overlay"
      ) {
        const event = command.envelope.event.event;
        broadcast = reduceBroadcast(broadcast, event);
        if (event.type === "codex.step") sdkSteps++;
      } else if (command.kind === "close") {
        clearInterval(clock);
        lines.close();
        process.stdin.destroy();
      } else if (command.kind !== "snapshot" && command.kind !== "event")
        throw new Error("Unknown game client command");
      process.stdout.write(
        `${JSON.stringify({ id, ok: true, snapshot: { frame: player.state.frame, hash: player.hash(), alive: player.state.alive, won: player.state.won, buildId, installs, broadcast, sdkSteps } })}\n`,
      );
    } catch {
      process.stdout.write(
        `${JSON.stringify({ id, ok: false, error: "Sandboxed game client rejected the operation" })}\n`,
      );
    }
  });
});
lines.once("close", () => clearInterval(clock));
