# Chat never writes code. Codex never sees the answer. The replay tests decide.

**Chat vs Codex:** viewers plant a real bug in the platformer a streamer is playing. Codex races viewers to diagnose
and repair the real TypeScript bug, checked by deterministic replay tests.

## For judges

| Criterion                                | Proof                                                                                                                                                                      | Film |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Innovation                               | [Real Twitch rounds](docs/LIVE-VERIFICATION.md), [round autopsies](https://chat-vs-codex-judge.vercel.app/#rounds)                                                         | TBD  |
| Potential Impact                         | [Second game](https://chat-vs-codex-judge.vercel.app/#second-game), [reusable game preparation](.agents/skills/hotfix-ready/SKILL.md)                                      | TBD  |
| Technological implementation incl. Codex | [Benchmark](bench/SUMMARY.md), [browser recomputation](https://chat-vs-codex-judge.vercel.app/#numbers), [sandbox canary](https://chat-vs-codex-judge.vercel.app/#sandbox) | TBD  |
| Design                                   | [Judge site](https://chat-vs-codex-judge.vercel.app/), [streaming and OBS](docs/STREAMING.md)                                                                              | TBD  |

211/212 fixes. Recompute: `pnpm bench:summary`.

Terra median 14.5 s across green trials. Recompute: `pnpm bench:summary`.

724 tests. Recompute: `pnpm test`.

Sol high finished green trials in a 29.40 second median. Both pass the GO gate.
[Results and limits](bench/SUMMARY.md) include the retained infrastructure loss,
alternate fixes and per-family timings. Raw [results](bench/results.jsonl) and
[run logs](bench/runs/) are retained for recomputation.

The [broadcast overlay](apps/overlay/README.md) renders the shared simulation with
a follow camera, keyboard play and a typed event contract. The
[Twitch foundation](packages/twitch/README.md) provides device authorization,
inbound EventSub routing and offline fixture replay. The [round loop](packages/round/README.md)
connects fixtures or `pnpm round:live` to runtime Codex, enum-only hint voting,
replay validation, state-preserving hot swap and rollback. Real fixture rounds
and an [offline Twitch broadcaster test](docs/rounds/82589ac9-1b1b-4393-8085-9bed5d88ee2b.json)
are verified. Broadcaster tests are labelled separately from viewer rounds.
The [streaming guide](docs/STREAMING.md) covers the offline channel test, OBS scene
import, keyboard play and Twitch account connection without a stored stream key.
The optional [Pit Wall phone app](apps/pit-wall/README.md) pairs over the LAN on
port 4318 for real round status, local alerts, streamer vetoes and enum hints.
The [Channel Points guide](docs/CHANNEL-POINTS.md) covers reward creation,
dashboard fallback and redemption settlement.
After new verified rounds, `pnpm chat-found:pr` opens one evidence-only regression
PR with hashed credits. See the [publication guide](docs/CHAT-FOUND.md).
The real [Twitch authorization and subscription check](docs/TWITCH-VERIFICATION.md)
verified the broadcaster and all nine subscriptions without sending chat.

## Build receipt

Main Codex thread: `01a19004-23e3-7883-89a7-f08faee625a5`.
Through turn 10, the thread ran 12 completed turns, 1,184 command executions and
146 file changes. Stephen counted the completed-turn, command-execution and
file-change records in the thread's JSON event logs outside this repository.
These are historical event counts, not unique files or current totals. The
private logs are not published here.

At that checkpoint, main had 54 commits, all authored by Stephen Sookra through
Codex. Recompute the checkpoint's reachable commits with
`git rev-list --count af1e0fe` and inspect authors with
`git log af1e0fe --format='%an'`. The judge site's
[build section](https://chat-vs-codex-judge.vercel.app/#build) computes the current
reachable commit count at build time with `git rev-list --count HEAD`.

Requires Node 22 and pnpm. Run `pnpm ci:local` to mirror the workflow: frozen
install, typecheck, lint, test and both Pit Wall bundles. `pnpm check` repeats
typecheck, lint and tests without installing.
Set `CI=true` when running the install without a TTY.
On a busy development machine, `CI=true VITEST_MAX_WORKERS=1 pnpm ci:local`
runs the same checks serially without changing their assertions or time budgets.

The [static judge site](apps/judge/README.md) recomputes benchmark numbers in the
browser, presents committed round receipts and re-simulates recorded validation
tracks when the matching build is available. Run `pnpm judge:build`; the static
output is `apps/judge/dist/`. Run `pnpm judge:smoke` for its Playwright preview check.

[Clay Breakout](games/breakout/README.md) is an original second game with seeded
replays and source-bound sidecar mutation sites. The repository's
[`hotfix-ready` skill](.agents/skills/hotfix-ready/SKILL.md) prepares small pure
TypeScript or JavaScript game modules through the same six mutation gates.

The [Game Inspector MCP](packages/inspector-mcp/README.md) gives runtime rounds
read-only player and enemy telemetry from the original visible replays. Its SDK
wiring is tested with a fake CLI and the real validation gate. The retained
benchmark predates Inspector; a real Inspector round and timing comparison remain
to be measured.

`packages/sim` is a DOM-free 60 Hz platformer using Q8 integers (256 units per
pixel). State and the level live outside paired mutation regions. The replay
package supplies seven hand-authored tracks, per-frame state hashes, recorded
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

The pool includes gravity reversal, collision boundary, swapped controls, coyote
expiry, jump buffer and enemy ledge-turn families. Ground, air and platform
control reversals are separate contexts. The first three families each have at
least three qualified mutants. Tests check the source digest and independently
execute representatives.
Regenerate it after changing simulation, replay inputs, goldens or the lockfile.
Minification is an equivalence filter, not a proof of semantic equivalence.

`pnpm bench --plan` prints the approved budget without making model calls. The
53-mutant pool currently requires 212 trials: three per mutant on
`gpt-6.1-terra` low and one on `gpt-6.1-sol` high. All qualified mutants, including
the other-family entries, are included. `pnpm bench --dry-run` attempts exactly
one Terra trial, excluded from scores, and never retries a sandbox denial.

Before a full run, use the existing local ChatGPT sign-in and Codex CLI 0.163.0:

```sh
pnpm ci:local
pnpm bench:canary && pnpm bench --run
```

The isolation canary is one separate runtime check, excluded from the 212 repair
trials. Its dedicated fixture puts a test file above the workspace and verifies
parent and host-skill reads, test/fixture writes, and network access are denied,
with positive controls. A trusted sandbox execution corroborates the SDK thread's
output. The canary also runs the real clean-source trial validator under the
hotfix profile and checks that temporary files stay inside the workspace. The
full bench requires its fresh local receipt, including this validation check.
Timing trial parents contain only `game`; dependencies are copied inside it, no clean source or
held-out inputs are present, and logs stay outside. Each game has one Git commit
containing the already-mutated source. Tests and fixtures are read-only under
the exact profile in `packages/bench/hotfix.toml`.

The pinned SDK uses `runStreamed`, a final output schema, raw permission overrides
and an exec launcher for flags the SDK does not expose. Runtime processes receive
an empty HOME and the real CODEX_HOME. The build process keeps its normal config.
Every workspace has an ignored `.tmp/` directory created before its single
commit. Runtime and validation share `TMPDIR`, `TMP` and `TEMP` pointing there;
all system-temp denies remain in place. Generated temp files are excluded from
source-change inspection.
The 240-second deadline aborts the SDK and has an independent worker-group kill.
Repairs pass the full visible suite and an unrevealed replay under the same
permission profile. Changes to tests, fixtures or tools are losses; source byte
equality against the clean build is recorded separately as exact-revert rate.

Before trial 1, every batch validates the clean source using the same sandbox,
environment, TypeScript command, full Vitest suite and held-out replay as trial
validation. A failure aborts before any repair thread starts and records its
output in `bench/runs/preflight-*.jsonl`. This check makes no model call. CI runs
the real verifier commands through a test executable to check environment and
failure propagation. Ubuntu CI does not provide the Mac's Codex/Seatbelt setup;
the mandatory outside-sandbox canary and batch preflight enforce the real profile.

Events, validation stdout/stderr and run manifests go to `bench/runs/*.jsonl`;
each trial appends to `bench/results.jsonl`. Return these files for committing
after an outside-sandbox run. The completed 212-trial batch is committed alongside
[its summary](bench/SUMMARY.md).
The single sandbox dry run exited before a model thread started: a PATH-alias
permission warning preceded a fatal permission-profile parsing error. Its raw
record says `sandbox-blocked`; the accompanying diagnosis identifies the fatal
config error. Quoted path keys now stay inside inline TOML override values,
verified against the unchanged profile offline. No second in-sandbox trial was attempted.
The first outside-sandbox batch then stopped after trial 1 because host validation
tried to write Vitest's SSR cache under `/tmp`. Runtime and validation now share
the workspace temp path, and clean sandbox validation gates the next batch.
Recompute with `pnpm bench --summary` (add `--batch <id>` for multiple batches).
Use `--head-start 15` to select the chat head start in seconds.

Reports separate models and families. Timing medians and nearest-rank p90 use
green trials; fix rates count every scored trial. Median confidence intervals
resample trials 5,000 times with a fixed seed. Reports include exact-revert rates,
greens before the head start and within 60 seconds, and the 120-second/70% gate.
Incomplete model schedules cannot earn GO. Camera qualification requires at least
10 observations and 80% green within 60 seconds; smaller groups say insufficient
sample. The confidence intervals describe these trials, not independent users.

MIT license, copyright Stephen Sookra.
