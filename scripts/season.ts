import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordSeason } from "../packages/round/src/season-store.js";

if (process.argv.slice(2).some((arg) => arg !== "--check"))
  throw new Error("Use pnpm season:record or pnpm season:check.");
const season = await recordSeason(
  resolve(fileURLToPath(new URL("..", import.meta.url))),
  process.argv.includes("--check"),
);
console.log(
  `Season checked: ${season.viewers.rounds} viewer rounds; ${season.tests.rounds} test rounds.`,
);
