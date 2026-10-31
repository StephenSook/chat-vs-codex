import type { ThreadEvent } from "@openai/codex-sdk";
import type { OverlayEvent } from "../../../apps/overlay/src/events.js";

/** Present only observed tool categories, never arbitrary agent text or output. */
export function sdkOverlayEvent(
  roundId: string,
  event: ThreadEvent,
): OverlayEvent | null {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  )
    return null;
  if (event.item.type !== "command_execution") return null;
  const item = event.item;
  const command = item.command.replace(
    /^(?:\/[a-z0-9_/-]+\/)?(?:ba|z)?sh\s+-lc\s+(['"])([\s\S]*)\1$/i,
    "$2",
  );
  const failed =
    item.status === "failed" ||
    (typeof item.exit_code === "number" && item.exit_code !== 0);
  const status = failed
    ? "failed"
    : item.status === "completed"
      ? "done"
      : "running";
  const base = {
    type: "codex.step" as const,
    roundId,
    id: item.id,
    attempt: 1,
    total: 1,
  };
  if (
    /^(?:(?:[^\s]*\/)?(?:vitest|pnpm\s+(?:run\s+)?test|npm\s+(?:run\s+)?test)|(?:[^\s]*\/)?node\s+(?:\.\/)?node_modules\/vitest\/vitest\.mjs\s+run)(?:[\s;]|$)/.test(
      command,
    )
  ) {
    // Overlay tests.done means "Tests green". A shell exit cannot establish
    // immutable visible + held-out validation, so only engine emits the green.
    if (status === "done") return null;
    return { ...base, step: { kind: "tests" }, status };
  }
  if (/^(?:pnpm\s+(?:run\s+)?)?replay:[a-z-]+(?:[\s;]|$)/.test(command))
    return { ...base, step: { kind: "replay" }, status };
  const reading = /^(?:[^\s]*\/)?(?:cat|head|tail|sed|rg)\s/.test(command);
  if (reading)
    return { ...base, step: { kind: "reading", path: "source" }, status };
  // SDK file_change lacks line counts; do not invent patch counts for the HUD.
  return null;
}
