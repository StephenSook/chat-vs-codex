import { expect, it, vi } from "vitest";
import { runVerifiedAb } from "../src/ab.js";

it("never creates a batch, preflight or paid runtime when current artifact verification fails", async () => {
  const manifest = vi.fn();
  const preflight = vi.fn();
  const runtime = vi.fn();
  const start = vi.fn(async () => {
    manifest();
    preflight();
    runtime();
  });
  await expect(
    runVerifiedAb(async () => {
      throw new Error("Stale feature extractor");
    }, start),
  ).rejects.toThrow("Stale feature extractor");
  expect(start).not.toHaveBeenCalled();
  expect(manifest).not.toHaveBeenCalled();
  expect(preflight).not.toHaveBeenCalled();
  expect(runtime).not.toHaveBeenCalled();
});
it("starts the run once and only after successful current artifact verification", async () => {
  const order: string[] = [];
  const start = vi.fn(async () => {
    order.push("run");
    return "done";
  });
  await expect(
    runVerifiedAb(async () => {
      order.push("verified");
    }, start),
  ).resolves.toBe("done");
  expect(order).toEqual(["verified", "run"]);
  expect(start).toHaveBeenCalledTimes(1);
});
