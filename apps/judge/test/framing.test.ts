import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RULE } from "../src/framing.js";

it("leads the README and judge hero with the same game rule", () => {
  const readme = readFileSync(
    new URL("../../../README.md", import.meta.url),
    "utf8",
  );
  expect(readme.split("\n")[0]).toBe(`# ${RULE}`);
});
