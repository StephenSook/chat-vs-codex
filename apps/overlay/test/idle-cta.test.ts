import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { initialBroadcast, reduceBroadcast } from "../src/events.js";
import { IDLE_CTA, idleCtaVisible } from "../src/presentation.js";

it("welcomes idle and raiding viewers, hiding the call to action throughout an active round", () => {
  const idle = initialBroadcast();
  expect(idleCtaVisible(idle)).toBe(true);
  const raid = reduceBroadcast(idle, { type: "twitch.raid", viewers: 42 });
  expect(idleCtaVisible(raid)).toBe(true);
  const preparing = reduceBroadcast(raid, { type: "round.preparing", id: "r" });
  expect(idleCtaVisible(preparing)).toBe(false);
  let active = reduceBroadcast(preparing, {
    type: "round.started",
    id: "r",
    number: 1,
    atMs: 0,
  });
  for (const event of [
    { type: "bug.active" as const, roundId: "r", intensity: 1 },
    { type: "tests.green" as const, roundId: "r" },
  ]) {
    active = reduceBroadcast(active, event);
    expect(idleCtaVisible(active)).toBe(false);
  }
  const receipt = JSON.parse(
    readFileSync(
      new URL(
        "../../../docs/rounds/82589ac9-1b1b-4393-8085-9bed5d88ee2b.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const finished = reduceBroadcast(active, {
    type: "round.autopsy",
    roundId: "r",
    autopsy: { ...receipt.autopsy, roundId: "r" },
  });
  expect(idleCtaVisible(finished)).toBe(true);
  expect(IDLE_CTA).toBe("Type !break to break the game · !guess to beat Codex");
});
