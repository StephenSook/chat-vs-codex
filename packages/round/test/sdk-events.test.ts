import type { ThreadEvent } from "@openai/codex-sdk";
import { expect, it } from "vitest";
import { sdkOverlayEvent } from "../src/sdk-events.js";

it("accepts the observed SDK null exit code as running, reserving green for the trusted validator", () => {
  // The committed real benchmark events contain null at item.started, although
  // SDK0.163's declared type describes the field as an optional number.
  const item = {
    id: "observed-tests",
    type: "command_execution",
    command: '/bin/zsh -lc "node node_modules/vitest/vitest.mjs run"',
    aggregated_output: "",
    status: "in_progress",
    exit_code: null,
  };
  expect(
    sdkOverlayEvent("round", {
      type: "item.started",
      item,
    } as unknown as ThreadEvent),
  ).toMatchObject({ status: "running", step: { kind: "tests" } });
  expect(
    sdkOverlayEvent("round", {
      type: "item.completed",
      item: { ...item, status: "completed", exit_code: 0 },
    } as unknown as ThreadEvent),
  ).toBeNull();
  expect(
    sdkOverlayEvent("round", {
      type: "item.completed",
      item: { ...item, status: "failed", exit_code: 1 },
    } as unknown as ThreadEvent),
  ).toMatchObject({ status: "failed" });
});
