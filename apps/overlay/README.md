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

The renderer reads `LEVEL`, player dimensions and `platformAt` from the sim's public API.
The clock calls the public `step` at 60 Hz; no physics are duplicated here. Unit tests
compare final states and hashes with `runTrack` at 30, 60 and 120 display Hz.

## Event integration

`window.chatVsCodex.events` implements the typed local `OverlayEventBus` in
`src/events.ts`. The operator bridge should translate observed `runStreamed` SDK events
into this contract. The SDK transport is not implemented at this checkpoint. No browser
API key is needed or accepted. Until a bridge sends activity, the ticker says
"Waiting for Codex". Test fixtures live only in tests.

- `round.started`: round id, number and start time in the receiving page's
  `performance.now()` timebase. Translate remote timestamps before publishing. Starts the
  15 second head start and resets round-local activity and deaths.
- `bug.active`: active round id and intensity from 0 to 1. The ticket shows `???` until
  `bug.named` arrives. This changes presentation, not the underlying sim build.
- `codex.step`: source item id, step, running/done/failed status and actual attempt/total.
  Reading uses the source basename; patch uses actual added/removed counts. Rows are capped
  at four, older attempts and other rounds are ignored. A completed tests step displays
  "Tests green"; also publish `tests.green` only after the real gate has passed to clear
  the active bug presentation. A command merely starting is never a passing result.
- `score.changed`: actual CHAT/CODEX scores. The overlay does not decide who won.
- `simulation.death`: emitted by the local sim on an alive-to-dead transition.

This is an in-process trusted interface, not a network ingestion or authentication boundary.
The bridge must validate external events before publishing them. `snapshot()` exposes the
current sim frame and hash for smoke verification, not an asserted result from a stored log.

## Visual verification

Build and start a preview in one terminal, then run the smoke checks in another:

```sh
pnpm --filter @chat-vs-codex/overlay build
pnpm --filter @chat-vs-codex/overlay preview --port 4173 --strictPort
pnpm --filter @chat-vs-codex/overlay smoke
```

The smoke runner requires installed Google Chrome. It checks the live canvas's state hash
against `runTrack`, idle activity, stage bounds, text sizes, countdown, failure vocabulary,
keyboard input and reduced motion. It writes stills to ignored `.local/overlay-stills/`:

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

## Filter experiment

Filters are OFF by default. `?filters=1` opts into an RGB split on the game layer only,
at the event intensity for 500 ms after activation. The HUD never receives a filter.
Steady corruption uses a static border and bolt; `tests.green` removes it. Reduced motion
disables the shader, including if the preference changes while running.

OBS encode cost at 4500 kbps is NOT VERIFIED. Before enabling a filter on stream, compare
the same scene with filters off/on in OBS at 1920 by 1080, 60 fps and 4500 kbps. Retain
encoding/render lag measurements and inspect the encoded 720p text. No measured performance
or visual verification is claimed by the existence of this implementation.

## Checkpoint status

Implemented: shared-sim renderer, clean input playback, keyboard play, scoreboard, death
counter, head-start fuse and local typed ticker. Workspace integration changes only the
workspace entries, root typecheck/test discovery and lockfile outside this app.

Pending: observed SDK bridge, active mutant build playback, autopsy, ghost replay and the
judge app. The judge app and its recorded-round proof start after the overlay checkpoint.
No site has been deployed.

The first verification attempt could not launch Chrome in the restricted execution sandbox
(SIGABRT at launch; permission error while cleaning up). The browser connector also required
unavailable approval. Thus rendered stills and visual readability remain NOT VERIFIED.
The full unit suite's mutation-pool binding requires a main-thread refresh because its
digest includes the entire changed workspace lockfile. Sim/replay/mutator sources and
fixtures have not been edited by this thread.
