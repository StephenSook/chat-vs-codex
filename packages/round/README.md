# Round loop

`pnpm round:live` uses the stored 0600 authorization in `.local/twitch/tokens.json`
and `TWITCH_CLIENT_ID` from the environment. It validates the refreshed token's
login, app, user and all 11 scopes, runs the clean sandbox gate, then opens one
EventSub WebSocket on `steve_sociall`, including while offline. Build the overlay
first. No command means no Codex call. Ctrl+C stops the listener and active round.

Use a different viewer account: the broadcaster doubles as the bot and its own
messages are ignored. Bare `!break` chooses a gated unlearned mutant. Whispering
one of the six enum families to the broadcaster selects a secret round; phone
verification and Twitch whisper restrictions still apply. `!guess <family>` is
accepted only for `gravity-sign`, `collision-off-by-one`, `swapped-controls`,
`coyote-never-expires`, `jump-buffer`, or `enemy-ledge-turn`. Starts have a 60 s
per-user cooldown. One round, including recording, must finish before another
starts. Chat and whisper text are never passed through to Codex.

For a single-account offline check, explicitly run
`pnpm round:live --allow-broadcaster-test`. This flag defaults off. It accepts the
broadcaster's typed `!break` and enum `!guess` commands while rejecting IDs returned
by Send Chat Message (including shared-chat source IDs) and every bot reply prefix.
Prefix checks also catch echoes delivered before the send response returns its ID.
Startup prints a warning; every round in the opted-in session carries
`trigger: "broadcaster-test"` in events, receipts and the autopsy's small row.
These receipts are excluded from normal previous-round comparisons. This flag
does not allow self-whispers or disable any sandbox, replay or hot-swap gate.

Live overlay attribution uses display names; public receipts and credited replay
files keep HMAC labels. Send Chat Message announces the start, first correct
guess and verified result. Markers at bug-in and fix-landed, the fix clip request,
and a raw `/helix/chat/pins` autopsy pin each require a fresh Get Streams live
result. Offline actions are skipped; refusals are logged in private `twitch.jsonl`
without failing the round. An accepted clip request does not prove publication.
`pnpm round:live --dry-chat` logs outgoing lines and skips all Twitch writes;
it still listens and starts real Codex repairs when viewers send commands.
The live command and HTTP contracts are fixture-tested; live delivery and OBS
pixels require streamer verification using [STREAMING.md](../../docs/STREAMING.md).

## Local fixture

The fixture runner feeds the Twitch package's bare `!break` payload through its
real handler, installs a gated mutant, waits the real 15-second chat head start,
then runs one `gpt-6.1-terra` low SDK repair. A fixture sends the wrong enum guess
`!guess swapped-controls` during a gravity round to exercise hint-war input.
This is a fixture round, not evidence of live Twitch event delivery.
The [verification status](../../docs/LOCAL-ROUND-CHECK.md) links the first completed
real SDK fixture round and retains the earlier nested-sandbox refusal.

```sh
CI=true pnpm ci:local
pnpm --filter @chat-vs-codex/overlay build
pnpm round:fixture
pnpm round:fixture --run
```

The command without `--run` prints the planned single runtime call. `--run`
first validates the clean source under the same hotfix profile, without a model
call. It aborts on a failed preflight and never retries a failed runtime. Use the
local ChatGPT sign-in and Codex CLI 0.163.0. Nested sandbox execution may be
blocked; run from a normal terminal when that occurs, keeping every permission
deny intact. Add `--serve` to keep the local overlay open after the round:
`http://127.0.0.1:4317/?bridge=http://127.0.0.1:4317`.

The engine owns phase, scoring and timers. One active round is allowed. Bare
break requests choose a server-side mutant from the six enum families; the
fixture selects an unlearned gated gravity mutant. Two-bug raid requests are
declined. The fixture command starts no live listener, chat writes or rewards.

During the head start, each actor's latest valid enum guess contributes one vote.
At its end, the top family becomes the one-word Codex hint; lexical order breaks
ties, and no votes means no hint. Free text never reaches the prompt. A correct
guess wins chat's point once; Codex continues repairing safely. Guesses close
60 seconds after the broken build is installed. Codex earns a point only after
validated repair activation within that window. Repair and cleanup can continue
after scoring closes, with a 240-second hard round budget and a separate worker
kill backstop. Correct, wrong and absent hints have unit coverage; no new timing
comparison between those conditions is claimed.

Runtime workspaces reuse the benchmark's neutral isolated directory, single
mutated commit, immutable tests/fixtures, stripped config, exact hotfix profile,
empty HOME, real CODEX_HOME, and workspace-local TMPDIR/TMP/TEMP. Logs and the
launcher are outside that directory. A detached worker is reaped on every exit.
Typecheck, all visible replays and the held-out route must pass; immutable files,
history and source snapshots are checked before a repaired artifact is exposed.
Bundling refuses canonical paths outside the workspace, including symlinks and
dormant dynamic imports. Neither tests nor executable source are trusted merely
because Codex reports success.

The loopback server sends sequenced events and SHA-256-addressed JavaScript
artifacts. The overlay verifies downloaded bytes, imports in order, then replaces
simulation functions without resetting live state, frame, RNG or clock carry.
Every observed SDK item drives a safe activity category, including command
execution, source reads by basename, edits, tool calls and responses. Completed
test commands show their command result; actual guarded source diffs provide
patch line counts. Arguments, command output and arbitrary agent text stay out of
the ticker. Command exit 0 does not claim tests green; only the engine publishes
green after the full gate and successful activation.
The terminal autopsy shows hashed breaker and first-correct attribution, the
revealed family, two excerpts of actual changed source lines, Codex's returned
headline (at most 60 characters), phase durations and a signed time-to-green delta. Full
source lines stay in the diff titles. Prior verified
receipts supply the comparison across runner invocations. A legacy or incompatible
prior measurement leaves the delta unavailable. Rollback cards carry no green
split; failed cleanup rolls back before publishing a success or Codex point.
After successful cleanup, a verified fix saves one credited regression under
[`chat-found/`](../../chat-found/README.md). The original planted mutant must
survive the canary and differ from clean replay expectations; a first-divergence
checkpoint preserves failures between 60-frame hashes. One record becomes one
immutable test in later workspaces. A saved record adds the autopsy's `+1 test`;
storage failure shows `Test not saved` while retaining the actual fix. Exact
learned mutation fingerprints are excluded from future selection and pool gates.
During validation, the held-out validator records the patched build's actual
per-frame positions and state hashes. After that run passes, its bounded trace
drives a translucent ghost and overview trail before the swap; playback may
continue afterward. Source fingerprints bind the trace to the installed repair,
and the public receipt retains trace hashes. Playback does not step the live game
or delay Codex, validation or activation. Failed held-out runs publish no trace.
Replayed events use the delivery clock so reconnection does not restart the head
start. Build-load failure blocks that round's later green and score messages.

Failed validation restores the trusted clean build. Abort and stale activation
guards prevent late callbacks from replacing it. Rollback or cleanup failure
stops further rounds and reports failure, never green. If the sandboxed headless
client itself dies during a stuck module probe, that client cannot be restored
in place; the round reports rollback failure and requires a restart. This does
not claim a successful recovery or an uninterrupted game in that failure case.

The local proof client executes patched code only under the hotfix profile. Its
VM module context adds a module boundary; the process sandbox is the filesystem
and network guard. The proof records actual frame/hash, installed build IDs,
preserved-state checks and received overlay events. Private logs and receipts
live under `.local/round-runs/`. Verified rounds also write a sanitized receipt
under `docs/rounds/`, with HMAC viewer labels and no raw viewer identities. Events
carry host-monotonic `atMs` and ISO `wallTime`; receipts separate actual head start,
SDK start to submitted patch, full validation, swap, and SDK start to installed
green. Missing legacy boundaries remain null. Browser pixels and OBS encoding still require
visual verification; the headless proof cannot establish either.
