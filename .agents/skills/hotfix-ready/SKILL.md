---

name: hotfix-ready
description: Prepare a small TypeScript or JavaScript game for deterministic Chat vs Codex repairs using sidecar mutation sites, replay tests, and a gated mutation pool.
---

Use this skill when the user asks to make a game hotfix-ready. Work on the requested game. Never rewrite game source just to insert mutation comments.

1. Read the simulation entry point and its callers. Separate browser rendering, wall-clock input collection, I/O and assets from deterministic game logic. Inspect imports and closure variables; the AST helper only proposes function bodies, it does not prove purity. Refuse an unsupported engine until a pure adapter exists. Do not claim that arbitrary DOM-heavy or nondeterministic games work automatically.
2. Add a small adapter exporting `createState(seed)`, `step(state, input)` at fixed 60 Hz and `hashState(state)`. Keep integer/fixed-point state and seeded RNG. Write finite per-frame bitmask tracks, a held-out track, and a scripted canary that remains alive and active (not won) for 1,200 frames. Test seed reproducibility and actual game rules. Preserve original source unless the user authorized deterministic adaptation.
3. Run the [sidecar helper](scripts/prepare.ts) with `discover <game-directory> src/<logic>.ts` (or `.js`). Review `hotfix-sites.json`: each source SHA binds zero-based, end-exclusive UTF-16 spans. The names represent `@hotfix-site` regions in this manifest only. Remove impure regions and immutable world definitions. Stale SHA or overlapping spans must refuse.
4. Implement `tracks.ts` and `replay.ts` following the checked [Breakout adapter](../../../games/breakout/replay.ts). Its `gateEvidence()` returns complete 600-frame replay samples, periodic hashes and outcomes plus `{frames,alive,won}` from the canary. Inputs stay finite; state must remain safe integers. The CLI refuses missing adapters rather than synthesizing fake evidence.
5. Run `gate <game-directory>`. The helper enumerates with Stryker without retaining instrumented source and applies one exact replacement in an isolated copy. A pooled mutant must compile, differ after minification, fail a replay, visibly diverge by over 32 px or die within 600 frames, finish within process/frame bounds, and leave the canary alive and active for 20 seconds. An empty pool is a failed preparation.
6. Record golden replay outputs, source/pool digests and every rejection category. Verify the game's source is byte-identical after preparation. Use the existing benchmark harness, hotfix profile, isolated neutral workspace and immutable fixtures for any authorized runtime trials. Do not start paid/model trials without the user's usage authorization.

Example in this repository:

```sh
pnpm exec tsx .agents/skills/hotfix-ready/scripts/prepare.ts discover games/breakout src/index.ts
pnpm exec tsx .agents/skills/hotfix-ready/scripts/prepare.ts gate games/breakout
pnpm exec tsx games/breakout/bench.ts --plan
```

The included CLI supports top-level named functions in flat `src/*.ts` or `src/*.js` modules and an explicit replay adapter. Adapt other layouts deliberately; do not silently broaden sites or skip gates.
