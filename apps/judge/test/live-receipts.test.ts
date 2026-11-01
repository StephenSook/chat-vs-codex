import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { deriveSeason } from "../../../packages/round/src/season.js";
import { type Receipt, type RoundNote, roundLabel } from "../src/evidence.js";

const read = (path: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
  );
const viewer = read(
  "docs/rounds/ac8b50c7-1012-4f20-af7e-10dd718b9f1c.json",
) as Receipt;
const boss = read(
  "docs/rounds/d4c4ec5f-b7e8-420e-bb16-91df94677f09.json",
) as Receipt;
const test = read(
  "docs/rounds/8a34be05-c8b6-45b1-b8ee-a04735d68cc4.json",
) as Receipt;
const notes = read("docs/round-notes.json") as Record<string, RoundNote>;
it("labels the actual chat-winning viewer receipt without publishing a name", () => {
  expect(roundLabel(viewer)).toBe("TWITCH CHAT ROUND / VIEWER");
  expect(viewer.winner).toBe("chat");
  expect(viewer.firstCorrectGuesser).toMatch(/^viewer-[a-f0-9]{16}$/);
  expect(viewer.firstCorrectGuesser).toBe(viewer.breaker);
});
it("labels the recorded boss and the operator-noted streamer start separately", () => {
  expect(boss.autopsy?.boss?.winner).toBe("terra");
  expect(roundLabel(boss, notes[boss.roundId])).toBe(
    "TWITCH BOSS ROUND / STREAMER START",
  );
  expect(roundLabel(boss)).toBe("TWITCH BOSS ROUND");
});
it("keeps the Saturday broadcaster receipt labelled TEST", () => {
  expect(roundLabel(test)).toBe("TWITCH CHAT ROUND / TEST");
});
it("keeps actual viewer, boss and TEST wins in distinct season buckets", () => {
  const season = deriveSeason([viewer, boss, test]);
  expect(season.viewers).toMatchObject({
    rounds: 1,
    chatWins: 1,
    codexWins: 0,
  });
  expect(season.bosses).toMatchObject({ rounds: 1, chatWins: 0, codexWins: 1 });
  expect(season.tests).toMatchObject({
    rounds: 1,
    broadcasterTests: 1,
    codexWins: 1,
  });
  expect(
    roundLabel({ ...boss, trigger: "broadcaster-test" }, notes[boss.roundId]),
  ).toBe("TWITCH CHAT ROUND / TEST");
});
