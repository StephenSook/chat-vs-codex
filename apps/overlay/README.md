# Broadcast overlay

PixiJS 8.22.0, pixi-filters 6.1.5 and Vite. The 1920 by 1080 stage scales as one unit to
1280 by 720. CHAT stays left in orange; CODEX stays right in blue with an original hexagon
terminal mark. All art is original vector geometry. Fonts are bundled locally; their OFL
copyright notices and licenses ship under `/licenses/`.

```sh
pnpm install --frozen-lockfile
pnpm --filter @chat-vs-codex/overlay dev --port 4173 --strictPort
```

Open `http://127.0.0.1:4173/` in a browser or an OBS browser source set to 1920 by 1080 at
60 fps. The default is a labelled clean sim replay using the replay package's hand-authored
`clean-flag` inputs and seed. It is not a recorded Codex round or benchmark result.
`?mode=play` enables arrows, Space and R for movement, jump and restart.
The default camera follows the player at twice the original renderer's scale, giving
the 24 px character about 43 screen pixels of height at 720p. `?camera=overview` keeps
the whole level visible for inspection.
The bug ticket sits above the playfield; the head start and Pit Crew use a right-hand dock.

The renderer reads `LEVEL`, player dimensions and `platformAt` from the sim's public API.
The purple enemy uses `state.enemy` position so its ledge turns and falls are visible.
The clock calls the public `step` at 60 Hz; no physics are duplicated here. Unit tests
compare final states and hashes with `runTrack` at 30, 60 and 120 display Hz.

## Event integration

`window.chatVsCodex.events` implements the typed local `OverlayEventBus` in
`src/events.ts`. The loopback round server translates observed `runStreamed` SDK events
into this contract. No browser API key is needed or accepted. Until a bridge sends activity, the ticker says
"Waiting for Codex". Test fixtures live only in tests.

- `round.started`: round id, number and start time in the receiving page's
  `performance.now()` timebase. Translate remote timestamps before publishing. Starts the
  configured head start (15 seconds by default) and resets round-local activity and deaths.
- `bug.active`: active round id and intensity from 0 to 1. The ticket shows `???` until
  `bug.named` arrives. This changes presentation, not the underlying sim build.
- `codex.step`: source item id, step, running/done/failed status and actual attempt/total.
  Reading uses the source basename; patch uses actual added/removed counts. Rows are capped
  at four, older attempts and other rounds are ignored. A completed tests step displays
  "Tests passed"; publish `tests.green` only after the real gate has passed to show the
  distinct "Tests green" row and clear
  the active bug presentation. A command merely starting is never a passing result.
- `score.changed`: actual CHAT/CODEX scores. The overlay does not decide who won.
- `simulation.death`: emitted by the local sim on an alive-to-dead transition.

This is an in-process trusted interface, not a network ingestion or authentication boundary.
The SSE bridge validates external events before publishing them. `snapshot()` exposes the
current sim frame and hash for smoke verification, not an asserted result from a stored log.

Use `?bridge=http://127.0.0.1:4317` to connect to the local round server. This switches
to keyboard play labelled "LOCAL ROUND". `GET /api/events` supplies sequenced `round` SSE
messages; the bridge installs each `game.build` before publishing later HUD activity.
Artifact bytes from `/api/builds/<sha256>.js` must match their SHA-256 id before import.
`SimulationPlayer.install()` validates the module against a frozen clone of the live
state, then replaces only its functions. State, frame, RNG and clock carry remain intact.
Load or validation failures retain the previous module and block green/score messages for
that round. The page displays "ROUND DISCONNECTED" with the error in its status tooltip.
Reconnection replays are deduplicated and ordered; stale round imports cannot replace a
newer round. Connections close on page exit. This bridge accepts loopback origins only.

An observed `round.ghost` carries the validated held-out route's recorded positions and
state hashes, tied to the submitted source digest. The blue translucent ghost plays those
samples at 60 Hz, with its trail in a fixed overview inset so the live follow camera does
not hide the route. It is labelled "RECORDED VALIDATED REPLAY". The repaired build must
have the same source digest before the bridge installs it. Playback never steps or resets
the live game, waits for no minimum animation duration, and can finish after the swap.
The last recorded frame stays visible until the next round or a rollback. Reduced motion
shows the full recorded route and its final sample without animation. No route appears
without an observed replay event. The snapshot includes its digests and displayed frame.

Server wall-clock starts are translated to the receiving page's monotonic clock using
the envelope's delivery-time `serverTimeMs`. Replayed envelopes therefore need a fresh
delivery clock while retaining their original sequence and round start.

## Visual verification

Build and start a preview in one terminal, then run the smoke checks in another:

```sh
pnpm --filter @chat-vs-codex/overlay build
pnpm --filter @chat-vs-codex/overlay preview --port 4173 --strictPort
pnpm --filter @chat-vs-codex/overlay smoke
```

The smoke runner requires installed Google Chrome. It checks the live canvas's state hash
against `runTrack`, idle activity, stage bounds, text sizes, countdown, failure vocabulary,
keyboard input, panel non-overlap at 720p, favicon and reduced motion. It writes stills to
ignored `.local/overlay-stills/`:

- `overlay-1080.png`: 1920 by 1080 default replay.
- `overlay-720.png`: 1280 by 720 default replay.
- `overlay-720-ui-test.png`: four ticker rows and head start with explicitly test-only events.

Required labels use at least 33 stage pixels, yielding 22 pixels at 720p; the round label
is nonessential metadata at 26 stage pixels. LOOK at all three stills at native size:
check player, spikes, moving platform and flag; verify the scorebug, countdown and all four
rows remain readable and do not obscure the player's route. The screenshot tests alone
cannot establish readability after stream encoding.

`OVERLAY_URL` selects another local URL; `OVERLAY_STILLS` selects the capture directory.
Stills are local working artifacts, not submission evidence.

## Active bug presentation

An observed `bug.active` enables RGB split and sparse scan bands inside the game by
default, at the supplied intensity. They persist while the observed bug is active;
`tests.green` or the next round clears them. The HUD never receives a filter. Reduced
motion uses static on-game color bands and disables RGB offsets, including if the
preference changes while running. A visual clock moves bands only while a bug is active;
it never creates agent steps, scores, passing tests or a bug activation.

OBS encode cost at 4500 kbps is NOT VERIFIED. Before enabling a filter on stream, compare
the same scene with filters off/on in OBS at 1920 by 1080, 60 fps and 4500 kbps. Retain
encoding/render lag measurements and inspect the encoded 720p text. No measured performance
or visual verification is claimed by the existence of this implementation.

## Checkpoint status

Implemented: shared-sim renderer, clean input playback, keyboard play, scoreboard, death
counter, head-start fuse and local typed ticker. Workspace integration changes only the
workspace entries, root typecheck/test discovery and lockfile outside this app.

Pending: autopsy, ghost replay and the
judge app. The judge app and its recorded-round proof start after the overlay checkpoint.
No site has been deployed.

OBS encode cost at 4500 kbps remains unmeasured. The local smoke checks do not establish
encoded-stream performance or visual readability. Sim/replay/mutator sources and fixtures
are unchanged by this app.

Main-thread verification: strict TypeScript, lint, 116 unit tests and the production
build pass. All four browser smoke tests were attempted, but Chrome exited at launch
with SIGABRT and EPERM before any page assertion ran. The browser connector also
requires approval unavailable in this noninteractive session. New rendered stills
and encoded OBS cost therefore remain NOT VERIFIED.
