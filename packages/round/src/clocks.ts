/** Host monotonic clock shared by local processes; never use wall time for elapsed durations. */
export function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function eventStamp() {
  return { atMs: monotonicMs(), wallTime: new Date().toISOString() };
}
