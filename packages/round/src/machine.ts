import { cpus, loadavg } from "node:os";
import { monotonicMs } from "./clocks.js";
import { type MachineLoad, validMachineLoad } from "./contracts.js";

/** The 1-minute load is measured against logical cores. This is an advisory, not a scheduler. */
export function sampleMachine(
  options: {
    loadavg?: () => readonly number[];
    cpus?: () => readonly unknown[];
    now?: () => number;
    wallTime?: () => string;
  } = {},
): MachineLoad {
  const load1m = (options.loadavg ?? loadavg)()[0];
  const coreCount = (options.cpus ?? cpus)().length;
  const sample = {
    load1m,
    coreCount,
    busy: load1m !== undefined && load1m > coreCount,
    atMs: (options.now ?? monotonicMs)(),
    wallTime: (options.wallTime ?? (() => new Date().toISOString()))(),
  };
  if (!validMachineLoad(sample))
    throw new Error("Machine load could not be measured");
  return sample;
}
