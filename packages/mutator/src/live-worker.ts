import { randomInt } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RegressionRecord } from "../../bench/src/regressions.js";
import {
  execute,
  gateCandidate,
  minified,
  ROOT,
  sourceDigest,
} from "./gate.js";
import { enumerateCandidates, selectableCandidates } from "./live.js";
import { runBounded } from "./process.js";

process.once(
  "message",
  async (input: {
    sourceDigest: string;
    regressions: RegressionRecord[];
    family?: string;
    scratch: string;
  }) => {
    try {
      if ((await sourceDigest()) !== input.sourceDigest)
        throw new Error("Live gate source changed before enumeration");
      const all = await enumerateCandidates();
      const candidates = selectableCandidates(
        all,
        input.sourceDigest,
        input.regressions,
        input.family,
      );
      const progress = {
        enumerated: all.length,
        eligible: candidates.length,
        attempted: 0,
      };
      process.send?.({ type: "progress", progress });
      if (!candidates.length)
        throw new Error(
          "No eligible candidates in the enumerated operator x site space",
        );
      // Shuffle the complete eligible space without giving pooled IDs priority.
      for (let i = candidates.length - 1; i > 0; i--) {
        const other = randomInt(i + 1);
        const a = candidates[i];
        const b = candidates[other];
        if (a && b) {
          candidates[i] = b;
          candidates[other] = a;
        }
      }
      const workspace = join(input.scratch, "game");
      await mkdir(workspace);
      for (const pkg of ["sim", "replay"]) {
        await cp(
          join(ROOT, "packages", pkg),
          join(workspace, "packages", pkg),
          { recursive: true, filter: (path) => !path.includes("node_modules") },
        );
        await symlink(
          join(ROOT, "packages", pkg, "node_modules"),
          join(workspace, "packages", pkg, "node_modules"),
          "dir",
        );
      }
      await symlink(
        join(ROOT, "node_modules"),
        join(workspace, "node_modules"),
        "dir",
      );
      await writeFile(join(workspace, "package.json"), '{"type":"module"}');
      await cp(
        join(ROOT, "tsconfig.base.json"),
        join(workspace, "tsconfig.base.json"),
      );
      await writeFile(
        join(workspace, "tsconfig.json"),
        JSON.stringify({
          extends: "./tsconfig.base.json",
          include: ["packages/sim/src/**/*.ts"],
        }),
      );
      const checkTypes = () =>
        runBounded(
          process.execPath,
          [
            join(ROOT, "node_modules/typescript/bin/tsc"),
            "--noEmit",
            "-p",
            join(workspace, "tsconfig.json"),
          ],
          workspace,
          15000,
        );
      checkTypes();
      const cleanCode = await minified(workspace);
      const clean = await execute(workspace, input.scratch);
      const goldens = JSON.parse(
        await readFile(
          join(ROOT, "packages/replay/fixtures/goldens.json"),
          "utf8",
        ),
      );
      for (const { name, result } of clean.tracks)
        if (
          JSON.stringify({ hashes: result.hashes, outcome: result.outcome }) !==
          JSON.stringify(goldens[name])
        )
          throw new Error(`Clean replay disagrees with golden: ${name}`);
      if (
        !clean.canary.outcome.alive ||
        clean.canary.outcome.won ||
        clean.canary.outcome.frame < 1200
      )
        throw new Error("Clean canary failed");
      for (const candidate of candidates) {
        progress.attempted++;
        process.send?.({ type: "progress", progress });
        const result = await gateCandidate(
          workspace,
          input.scratch,
          cleanCode,
          clean,
          candidate,
          checkTypes,
        );
        if ("accepted" in result) {
          if ((await sourceDigest()) !== input.sourceDigest)
            throw new Error("Source changed while gating live mutation");
          process.send?.({
            type: "accepted",
            mutant: result.accepted,
            progress,
          });
          process.disconnect();
          return;
        }
      }
      throw new Error(
        "All enumerated candidates were rejected; no timeout fallback is permitted",
      );
    } catch (error) {
      process.send?.({ type: "error", error: String(error) });
      process.disconnect();
    }
  },
);
