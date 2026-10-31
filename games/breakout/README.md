# Clay Breakout

An original paddle-and-brick game with fixed-point 60 Hz physics and original Canvas art. Arrow keys move, Space launches, R restarts.

```sh
pnpm breakout:dev
pnpm breakout:build
```

The source contains no mutation comments. `hotfix-sites.json` binds reviewed function spans to their source SHA. Seeded tracks, golden hashes and a 20-second follow-ball canary support the six mutation gates.

The reusable [skill](../../.agents/skills/hotfix-ready/SKILL.md) lives in
`.agents/skills/hotfix-ready/`. Invoke `$hotfix-ready` in Codex, or run its helper
through `pnpm hotfix:ready`.

```sh
pnpm hotfix:ready discover games/breakout src/index.ts
pnpm breakout:pool
pnpm breakout:bench --plan
pnpm breakout:bench --dry-run
pnpm breakout:bench --run
pnpm breakout:bench --summary
```

The batch runs three total Terra-low trials through the existing Codex SDK harness. Clean validation runs under the hotfix profile before trial 1. Trials have neutral isolated workspaces, immutable fixtures, a held-out route, `.tmp` inside the workspace and the existing 240-second abort. A sandbox refusal stops the batch without retry. The dry run is one excluded trial; authorize any additional model usage separately.

Raw evidence goes to `games/breakout/bench/results.jsonl` and `games/breakout/bench/runs/`. A pool or fake-CLI contract test alone is not evidence that a real model repaired this game.
