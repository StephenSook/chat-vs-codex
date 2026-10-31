import { readFileSync, statSync } from "node:fs";
import { parseInspectorData } from "./index.js";
import { lineTransport, protocol } from "./protocol.js";

/** Bundled beside this fixed data file; no CLI argument selects a path. */
try {
  const file = new URL("./traces.json", import.meta.url);
  if (process.argv.length !== 2 || statSync(file).size > 16 * 1024 * 1024)
    throw new Error("Invalid server launch");
  const data = parseInspectorData(JSON.parse(readFileSync(file, "utf8")));
  process.stdin.on(
    "data",
    lineTransport(
      protocol(data),
      (line) => {
        process.stdout.write(`${line}\n`);
      },
      () => {
        process.exitCode = 1;
        process.stdin.destroy();
      },
    ),
  );
} catch {
  process.stderr.write("Game Inspector telemetry is unavailable or invalid\n");
  process.exitCode = 1;
}
