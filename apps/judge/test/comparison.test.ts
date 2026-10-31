import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { RegressionRecord } from "../../../packages/bench/src/regressions.js";
import {
  committedComparison,
  committedSimulation,
  committedSource,
} from "../../../scripts/judge-evidence.js";
import {
  comparisonAvailability,
  comparisonFrames,
  comparisonVisibleFrame,
  replayComparison,
} from "../src/comparison.js";
import type {
  ComparisonEvidence,
  JudgeEvidence,
  Receipt,
} from "../src/evidence.js";
import { type GameModule, sha256 } from "../src/proof.js";

const ids = [
  "c81bdc19-304f-47d5-800e-5098b9a1b5e2",
  "c37736fc-52d2-4ca0-9eee-dae78a5eff7b",
];
const read = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const moduleFrom = (code: string): Promise<GameModule> =>
  import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
let replay: JudgeEvidence["replay"];
let fixed: GameModule;
let fixtures: {
  receipt: Receipt;
  regression: RegressionRecord;
  comparison: Extract<ComparisonEvidence, { status: "available" }>;
  broken: GameModule;
}[];

beforeAll(async () => {
  const source = committedSource();
  const simulation = await committedSimulation(source);
  replay = {
    artifactPath: "game.js",
    buildDigest: simulation.digest,
    track: simulation.track,
  };
  fixed = await moduleFrom(simulation.code);
  fixtures = [];
  for (const id of ids) {
    const receipt = JSON.parse(read(`docs/rounds/${id}.json`)) as Receipt;
    const text = read(`chat-found/${id}.json`);
    const regression = JSON.parse(text) as RegressionRecord;
    const artifacts = new Map<string, string>();
    // The actual committed fixture may first be staged by this build turn. The
    // simulation still reads only pinned committed blobs, never dirty game code.
    const fixtureSource = {
      ...source,
      read: (path: string) =>
        path === `chat-found/${id}.json` ? text : source.read(path),
    };
    const comparison = await committedComparison(
      fixtureSource,
      receipt,
      { path: `evidence/chat-found/${id}.json`, digest: await sha256(text) },
      simulation.digest,
      (path, code) => {
        artifacts.set(path, code);
        return path;
      },
      simulation,
    );
    expect(comparison.status).toBe("available");
    if (comparison.status !== "available") throw new Error(comparison.reason);
    const code = artifacts.get(comparison.brokenArtifactPath);
    if (!code) throw new Error("Missing exact original artifact");
    expect(await sha256(code)).toBe(receipt.verification.builds[0]?.digest);
    fixtures.push({
      receipt,
      regression,
      comparison,
      broken: await moduleFrom(code),
    });
  }
}, 15000);

describe("recorded broken and repaired comparison", () => {
  it("re-simulates both real gravity and ledge-enemy rounds on the same committed display replay inputs", async () => {
    for (const fixture of fixtures) {
      const result = await replayComparison(
        fixture.broken,
        fixed,
        fixture.comparison,
        fixture.regression,
        fixture.receipt,
      );
      const display = fixture.comparison.display;
      expect(result.broken.length).toBe(display.track.inputs.length);
      expect(result.fixed.length).toBe(result.broken.length);
      expect(result.firstDivergence).toBe(display.firstDivergence);
      expect(result.visibleFrame).toBe(display.visibleFrame);
      expect(result.visibleFrame).toBeLessThanOrEqual(600);
      expect(comparisonVisibleFrame(fixed, result.broken, result.fixed)).toBe(
        result.visibleFrame,
      );
      expect(result.broken[result.firstDivergence - 1]?.stateHash).not.toBe(
        result.fixed[result.firstDivergence - 1]?.stateHash,
      );
    }
    const gravity = fixtures[0];
    if (!gravity) throw new Error("Missing actual gravity round");
    const shown = await replayComparison(
      gravity.broken,
      fixed,
      gravity.comparison,
      gravity.regression,
      gravity.receipt,
    );
    const visible = shown.visibleFrame;
    if (visible === undefined) throw new Error("Missing real visible frame");
    const original = shown.broken[visible - 1];
    const repaired = shown.fixed[visible - 1];
    if (!original || !repaired) throw new Error("Missing visible positions");
    expect(
      original.alive !== repaired.alive ||
        (original.x - repaired.x) ** 2 + (original.y - repaired.y) ** 2 >
          (32 * fixed.UNIT) ** 2,
    ).toBe(true);
    const canary = gravity.regression.routes[gravity.comparison.routeIndex];
    if (!canary) throw new Error("Missing original canary oracle");
    expect(
      comparisonVisibleFrame(
        fixed,
        comparisonFrames(gravity.broken, canary.track),
        comparisonFrames(fixed, canary.track),
      ),
    ).toBeNull();
    const enemy = fixtures[1];
    if (!enemy) throw new Error("Missing actual ledge-enemy round");
    const result = await replayComparison(
      enemy.broken,
      fixed,
      enemy.comparison,
      enemy.regression,
      enemy.receipt,
    );
    const witness = result.visibleFrame;
    if (witness === undefined) throw new Error("Missing visible enemy frame");
    const brokenEnemy = result.broken[witness - 1]?.enemy;
    const fixedEnemy = result.fixed[witness - 1]?.enemy;
    if (!brokenEnemy || !fixedEnemy)
      throw new Error("Missing actual enemy positions");
    expect(
      (brokenEnemy.x - fixedEnemy.x) ** 2 + (brokenEnemy.y - fixedEnemy.y) ** 2,
    ).toBeGreaterThan((32 * fixed.UNIT) ** 2);
  });

  it("refuses altered original frames, wrong artifacts and oversized inputs", async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error("Missing actual gravity round");
    await expect(
      replayComparison(
        fixed,
        fixed,
        fixture.comparison,
        fixture.regression,
        fixture.receipt,
      ),
    ).rejects.toThrow("recorded broken trace");
    const altered = structuredClone(fixture.regression);
    const sample = altered.routes[0]?.buggy.samples[0];
    if (!sample) throw new Error("Missing original sample");
    sample.x += 1;
    await expect(
      replayComparison(
        fixture.broken,
        fixed,
        fixture.comparison,
        altered,
        fixture.receipt,
      ),
    ).rejects.toThrow("trace digest");
    const excessive = structuredClone(fixture.regression);
    const route = excessive.routes[fixture.comparison.routeIndex];
    if (!route) throw new Error("Missing original route");
    route.track.inputs = Array(3601).fill(0);
    await expect(
      replayComparison(
        fixture.broken,
        fixed,
        fixture.comparison,
        excessive,
        fixture.receipt,
      ),
    ).rejects.toThrow("frame budget");
    const round = {
      receipt: fixture.receipt,
      path: "receipt.json",
      digest: "a".repeat(64),
      regression: {
        path: fixture.comparison.regressionPath,
        digest: fixture.comparison.regressionDigest,
        retroactive: false,
      },
      comparison: fixture.comparison,
    };
    expect(comparisonAvailability(round, replay)).toBeNull();
    expect(
      comparisonAvailability(
        {
          ...round,
          comparison: {
            ...fixture.comparison,
            brokenBuildDigest: "f".repeat(64),
          },
        },
        replay,
      ),
    ).toContain("do not match");
  });

  it("rejects wrong display inputs, frame digests and visible metadata", async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error("Missing actual gravity round");
    for (const field of [
      "track",
      "brokenFramesDigest",
      "fixedFramesDigest",
      "visibleFrame",
      "firstDivergence",
    ] as const) {
      const changed = structuredClone(fixture.comparison);
      if (field === "track") changed.display.track.seed += 1;
      else if (field === "visibleFrame" || field === "firstDivergence")
        changed.display[field] += 1;
      else changed.display[field] = "f".repeat(64);
      await expect(
        replayComparison(
          fixture.broken,
          fixed,
          changed,
          fixture.regression,
          fixture.receipt,
        ),
      ).rejects.toThrow("visible witness do not match");
    }
    // The original canary is a valid evidence oracle but only jitters 0.5 px.
    // Even self-consistent frame hashes must never promote it to a visible reel.
    const route = fixture.regression.routes[fixture.comparison.routeIndex];
    if (!route) throw new Error("Missing original route");
    const subtle = structuredClone(fixture.comparison);
    subtle.display.track = route.track;
    const broken = comparisonFrames(fixture.broken, route.track);
    const repaired = comparisonFrames(fixed, route.track);
    subtle.display.trackDigest = await sha256(JSON.stringify(route.track));
    subtle.display.brokenFramesDigest = await sha256(JSON.stringify(broken));
    subtle.display.fixedFramesDigest = await sha256(JSON.stringify(repaired));
    subtle.display.firstDivergence = route.firstDivergence ?? 1;
    subtle.display.visibleFrame = subtle.display.firstDivergence;
    await expect(
      replayComparison(
        fixture.broken,
        fixed,
        subtle,
        fixture.regression,
        fixture.receipt,
      ),
    ).rejects.toThrow("visible witness do not match");
  });

  it("fails closed on historical source/build drift and mismatched mutation bindings", async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error("Missing actual gravity round");
    const source = committedSource();
    const path = fixture.comparison.regressionPath.replace(/^evidence\//, "");
    const text = read(path);
    const record = {
      path: fixture.comparison.regressionPath,
      digest: await sha256(text),
    };
    const fixtureSource = {
      ...source,
      read: (file: string) => (file === path ? text : source.read(file)),
    };
    const emit = () => {
      throw new Error("Unavailable comparison must not emit an artifact");
    };
    expect(
      await committedComparison(
        fixtureSource,
        fixture.receipt,
        record,
        "f".repeat(64),
        emit,
      ),
    ).toMatchObject({ status: "unavailable" });
    const changedSource = {
      ...fixtureSource,
      read: (file: string) =>
        file === "packages/sim/src/index.ts"
          ? `${source.read(file)}\n// dirty historical simulation\n`
          : fixtureSource.read(file),
    };
    expect(
      await committedComparison(
        changedSource,
        fixture.receipt,
        record,
        replay.buildDigest,
        emit,
      ),
    ).toMatchObject({ status: "unavailable" });
    if (!fixture.receipt.mutation)
      throw new Error("Missing real mutation provenance");
    await expect(
      committedComparison(
        fixtureSource,
        {
          ...fixture.receipt,
          mutation: {
            ...fixture.receipt.mutation,
            candidateDigest: "f".repeat(64),
          },
        },
        record,
        replay.buildDigest,
        emit,
      ),
    ).rejects.toThrow("mutation does not match");
  });
});
