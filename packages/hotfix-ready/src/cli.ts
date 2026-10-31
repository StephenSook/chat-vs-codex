import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gatePool } from "./gate.js";
import { discoverRegions, type HotfixManifest } from "./manifest.js";

const [mode, directoryArg, ...files] = process.argv.slice(2);
if (!directoryArg || !["discover", "gate"].includes(mode ?? ""))
  throw new Error(
    "Usage: hotfix-ready discover <game> <src/file.ts...> | gate <game>",
  );
const directory = resolve(directoryArg);
if (mode === "discover") {
  if (!files.length) throw new Error("Name the pure source modules to review");
  const entries = [];
  for (const file of files) {
    if (!/^src\/[a-zA-Z0-9_-]+\.(?:ts|js)$/.test(file))
      throw new Error("Unsupported source path");
    entries.push(
      discoverRegions(await readFile(join(directory, file), "utf8"), file),
    );
  }
  const manifest: HotfixManifest = { schemaVersion: 1, files: entries };
  await writeFile(
    join(directory, "hotfix-sites.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Sidecar created. Review ${entries.reduce((n, file) => n + file.regions.length, 0)} candidate regions before gating. Game source unchanged.`,
  );
} else {
  const pool = await gatePool(directory, process.cwd());
  if (!pool.mutants.length)
    throw new Error("No candidate passed every gate; pool was not written");
  await writeFile(
    join(directory, "pool.json"),
    `${JSON.stringify(pool, null, 2)}\n`,
  );
  console.log(
    `${pool.mutants.length}/${pool.enumerated} passed all six gates.`,
  );
}
