import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { bundleGame } from "../../round/src/runtime-execution.js";
import { confinedBundlePlugin } from "../src/confined-bundle.js";

describe("patched-source bundle confinement", () => {
  it("bundles real workspace modules but refuses dormant imports of outside JSON before exposing its bytes", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "bundle-boundary-"));
    const game = join(scratch, "game");
    try {
      await mkdir(game);
      const sentinel = "outside-sentinel-must-never-enter-artifacts";
      await writeFile(
        join(scratch, "sentinel.json"),
        JSON.stringify({ value: sentinel }),
      );
      await writeFile(
        join(game, "inside.json"),
        JSON.stringify({ value: "allowed-local-module" }),
      );
      const entry = join(game, "index.ts");
      await writeFile(entry, "export const load=()=>import('./inside.json');");
      expect((await bundleGame(entry, game)).code).toContain(
        "allowed-local-module",
      );
      for (const specifier of [
        "../sentinel.json",
        join(scratch, "sentinel.json"),
      ]) {
        await readFile(entry, "utf8");
        await writeFile(
          entry,
          `export const dormant=()=>import(${JSON.stringify(specifier)});`,
        );
        let returned = "";
        await expect(
          bundleGame(entry, game).then((result) => {
            returned = result.code;
          }),
        ).rejects.toThrow("escapes runtime workspace");
        expect(returned).not.toContain(sentinel);
        // The held-out Node bundle uses the same plugin and scans dormant imports too.
        await expect(
          build({
            entryPoints: [entry],
            bundle: true,
            platform: "node",
            format: "esm",
            write: false,
            logLevel: "silent",
            plugins: [confinedBundlePlugin(game)],
          }),
        ).rejects.toThrow("escapes runtime workspace");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("rejects symlink and package escapes, protocols and automatic Node externals", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "bundle-alias-"));
    const game = join(scratch, "game");
    try {
      await mkdir(join(game, "node_modules"), { recursive: true });
      await mkdir(join(scratch, "outside-package"));
      await writeFile(
        join(scratch, "outside-package/package.json"),
        JSON.stringify({ name: "escape", main: "index.js" }),
      );
      await writeFile(
        join(scratch, "outside-package/index.js"),
        "export const value='outside';",
      );
      await symlink(
        join(scratch, "outside-package"),
        join(game, "node_modules/escape"),
        "dir",
      );
      await symlink(
        join(scratch, "outside-package/index.js"),
        join(game, "alias.js"),
      );
      const entry = join(game, "index.ts");
      for (const specifier of [
        "./alias.js",
        "escape",
        "node:fs",
        "fs",
        "https://example.invalid/code.js",
        "data:text/javascript,export default 1",
      ]) {
        await writeFile(
          entry,
          `export const load=()=>import(${JSON.stringify(specifier)});`,
        );
        await expect(
          build({
            entryPoints: [entry],
            bundle: true,
            platform: "node",
            format: "esm",
            write: false,
            logLevel: "silent",
            plugins: [confinedBundlePlugin(game)],
          }),
        ).rejects.toThrow(/escapes runtime workspace|imports are forbidden/);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
