import { executeRepair, type RepairExecution } from "./runtime-execution.js";

process.once("message", (options: RepairExecution) => {
  void executeRepair(
    options,
    new AbortController().signal,
    (event) => {
      process.send?.({ type: "event", event });
    },
    {},
    (observation) => {
      process.send?.({ type: "observation", observation });
    },
  ).then(
    (artifact) =>
      process.send?.({ type: "result", artifact }, () => process.disconnect()),
    () =>
      process.send?.(
        {
          type: "error",
          error:
            "Runtime repair or deterministic verification failed. See private round log.",
        },
        () => process.disconnect(),
      ),
  );
});
