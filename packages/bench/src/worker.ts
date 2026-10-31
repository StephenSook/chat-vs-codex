import { executeTrial, type TrialOptions } from "./trial.js";

process.once("message", (options: TrialOptions) => {
  void executeTrial(options)
    .then((result) => {
      process.send?.({ type: "result", result }, () => process.disconnect());
    })
    .catch((error: unknown) => {
      process.send?.({ type: "error", error: String(error) }, () =>
        process.disconnect(),
      );
    });
});
