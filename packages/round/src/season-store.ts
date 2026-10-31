import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveSeason,
  type SeasonReceipt,
  type SeasonScoreboard,
} from "./season.js";

export async function loadSeason(directory: string): Promise<SeasonScoreboard> {
  const names = (await readdir(directory))
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .sort();
  const receipts = await Promise.all(
    names.map(async (name) => {
      const row = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as SeasonReceipt & { schemaVersion: number };
      if (row.schemaVersion !== 1 || row.roundId !== name.slice(0, -5))
        throw new Error(`Invalid season receipt: ${name}`);
      return row;
    }),
  );
  return deriveSeason(receipts);
}

export async function recordSeason(
  root: string,
  check: boolean,
): Promise<SeasonScoreboard> {
  const season = await loadSeason(join(root, "docs/rounds"));
  const expected = `${JSON.stringify(season, null, 2)}\n`;
  const path = join(root, "docs/season.json");
  if (check) {
    if ((await readFile(path, "utf8")) !== expected)
      throw new Error(
        "Season receipt is stale. Run pnpm season:record and commit docs/season.json.",
      );
  } else await writeFile(path, expected);
  return season;
}
