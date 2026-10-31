import { readFile, writeFile } from "node:fs/promises";
import { goldenResult, TRACKS } from "./index.js";

const target = new URL("../fixtures/goldens.json", import.meta.url);
const content = `${JSON.stringify(Object.fromEntries(TRACKS.map((track) => [track.name, goldenResult(track)])), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error("Replay goldens are stale");
} else {
  await writeFile(target, content);
}
