import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, it } from "vitest";
import { copyDependencies } from "../src/dependencies.js";

it("keeps headless tools confined while omitting only Vite's unused optional minifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "dependency-closure-"));
  const game = join(root, "game");
  async function installed(name: string, extra: object = {}) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, version: "1.0.0", ...extra }),
    );
    await writeFile(join(dir, "index.js"), "export const value = 1;\n");
  }
  try {
    await installed("vitest", {
      dependencies: { "required-tool": "1.0.0", vite: "1.0.0" },
      optionalDependencies: { "platform-binary": "1.0.0" },
      peerDependencies: {
        "required-peer": "1.0.0",
        "optional-headless-peer": "1.0.0",
      },
      peerDependenciesMeta: { "optional-headless-peer": { optional: true } },
    });
    await installed("vite", {
      peerDependencies: { lightningcss: "1.0.0", terser: "1.0.0" },
      peerDependenciesMeta: {
        lightningcss: { optional: true },
        terser: { optional: true },
      },
    });
    for (const name of [
      "typescript",
      "@types/node",
      "pure-rand",
      "required-tool",
      "platform-binary",
      "required-peer",
      "lightningcss",
      "terser",
      "optional-headless-peer",
    ])
      await installed(name);
    await copyDependencies(game, root);
    const packages = [];
    const boundary = await realpath(game);
    for (const id of await readdir(join(game, "node_modules/.isolated"))) {
      const dir = join(game, "node_modules/.isolated", id);
      packages.push(
        JSON.parse(await readFile(join(dir, "package.json"), "utf8")).name,
      );
      expect((await realpath(dir)).startsWith(`${boundary}${sep}`)).toBe(true);
    }
    expect(packages).toEqual(
      expect.arrayContaining([
        "vitest",
        "typescript",
        "@types/node",
        "pure-rand",
        "required-tool",
        "platform-binary",
        "required-peer",
        "vite",
        "optional-headless-peer",
      ]),
    );
    expect(packages).not.toContain("lightningcss");
    expect(packages).not.toContain("terser");
    const vitest = await realpath(join(game, "node_modules/vitest"));
    for (const name of [
      "required-tool",
      "platform-binary",
      "required-peer",
      "vite",
      "optional-headless-peer",
    ])
      expect(
        (await realpath(join(vitest, "node_modules", name))).startsWith(
          `${boundary}${sep}`,
        ),
      ).toBe(true);
    await rm(join(root, "node_modules/required-tool"), { recursive: true });
    await expect(
      copyDependencies(join(root, "missing-peer-game"), root),
    ).rejects.toThrow("Missing dependency required-tool");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
