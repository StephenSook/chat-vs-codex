# Chat vs Codex

Chat breaks the platformer a streamer is playing. Codex races viewers to diagnose
and repair the real TypeScript bug, checked by deterministic replay tests.

This repository starts with the timing spike's simulation, replay fixtures and
offline mutation gate. Twitch, rendering and runtime Codex are later steps.

Requires Node 22 and pnpm. Run `pnpm install`, then `pnpm check`.

`packages/sim` is a DOM-free 60 Hz platformer using Q8 integers (256 units per
pixel). State and the level live outside paired mutation regions. The replay
package supplies three hand-authored tracks, per-frame state hashes, recorded
60-frame FNV-1a checkpoints, and a separate held-out route.

- `pnpm replay:check` verifies recorded goldens without changing them.
- `pnpm replay:record` deliberately replaces goldens after a reviewed behavior change.
- `pnpm mutator:pool` enumerates and gates every hotfix candidate. Allow a few minutes.

Stryker 9.3.0 only supplies candidates. Injection splices one replacement into the
original source after checking its bytes and region. Pool entries in
`packages/mutator/pool.json` passed TypeScript, differed after esbuild minification,
failed a replay and visibly diverged within 600 frames. Each replay has a 3,600-frame
limit and runs in a process killed after three seconds. A scripted canary jumps,
moves briefly, then waits; it must remain alive and outside a terminal state for
1,200 frames. This proves survival, not that the flag remains reachable.

The pool includes gravity reversal, collision boundary and swapped-control
families. Tests check its source digest and independently execute representatives.
Regenerate it after changing simulation, replay inputs, goldens or the lockfile.
Minification is an equivalence filter, not a proof of semantic equivalence.

Runtime Codex and benchmark statistics are pending. No timing or fix-rate claim
has been measured by this repository yet.

MIT license, copyright Stephen Sookra.
