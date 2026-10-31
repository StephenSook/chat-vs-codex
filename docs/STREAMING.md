# Streaming Chat vs Codex

Use Node 22, pnpm, Codex CLI 0.163.0 and the existing ChatGPT sign-in on the
streaming Mac. Twitch authorization is already stored in
`.local/twitch/tokens.json` with mode 0600. Keep this file and all `.local/` logs
private. The runner reads the public Client ID from `TWITCH_CLIENT_ID`.

## Sound and optional voice

The generated OBS browser-source URL includes `sound=on`, which arms sound without
a click at 15% volume on each page load. In the browser source's **Properties**,
enable **Control audio via OBS**, then press **Refresh cache of current page**.
The source appears in OBS's Audio Mixer. Keep the browser-source fader at unity
initially; the overlay already applies the stream-safe volume.

The small corner speaker icon mutes audio; its adjacent slider changes volume.
Use OBS's **Interact** window to operate those controls. Normal browsers without
`sound=on` still require a click on the speaker icon to enable sound. If a browser
blocks autoplay, the same icon restores the click-to-enable path. No large sound
button or instruction is drawn on the broadcast. The controls also govern voice.

Commentary is off by default. With AWS credentials already available through the
standard provider chain, opt in for one runner session:

```sh
POLLY_ENABLED=1 pnpm round:live --allow-broadcaster-test
```

This uses Amazon Polly's neural Joanna voice in `us-east-1`. AWS credentials stay
in their normal provider; the application never writes them. Fixed phase lines
are cached under `.local/polly/` with mode 0600. A verified fix speaks its measured
GREEN duration, rounded to seconds. Voice is at most one short line per phase;
chat text is never synthesized. Reconnects do not replay old commentary. Disabled
commentary performs no AWS calls; an enabled-provider failure leaves the round
running with its original sounds.

## Check the round while offline

Leave OBS's **Start Streaming** button alone for this check. From a normal terminal
in this repository, run:

```sh
CI=true pnpm ci:local
pnpm --filter @chat-vs-codex/overlay build
export TWITCH_CLIENT_ID="$(security find-generic-password -s twitch-chat-vs-codex-client-id -w)"
pnpm round:live
```

The runner prints its private log directory, validates the clean game under the
hotfix profile, verifies `steve_sociall` and exactly 11 scopes, then prints the
overlay URL and EventSub connection status. It starts Codex only after an accepted
viewer command. If sandbox validation fails, stop and inspect the private log;
no profile denies should be removed. Ctrl+C closes the socket, cancels an active
round, and closes the sandbox client and local server.

Open the printed URL to preview. In another Twitch account, open
[steve_sociall's chat](https://www.twitch.tv/steve_sociall/chat) and send:

```text
!break
```

The broadcaster account doubles as the bot. Its own commands are ignored. The
reply should be `Something broke. Chat has 15 s.` During the head start, viewers
may send `!guess gravity-sign`, replacing the family with one of:

```text
gravity-sign
collision-off-by-one
swapped-controls
coyote-never-expires
jump-buffer
enemy-ledge-turn
```

If no second account is available, stop the runner and explicitly opt into the
single-account test mode:

```sh
pnpm round:live --allow-broadcaster-test
```

Use `steve_sociall` to type `!break` and optionally `!guess gravity-sign`. The
flag is off by default. It prints a warning and labels **all session rounds**
`trigger: "broadcaster-test"` in events, public receipts and the autopsy's small
row, so they cannot be presented as viewer rounds. Bot replies remain ignored by
returned message ID, shared-chat source ID and reply prefix, including early
echoes before Send Chat Message returns. Test receipts use a separate previous
split baseline. Return to plain `pnpm round:live` for viewer participation.

A bare break keeps the selected family secret. For a known secret test, whisper
exactly `gravity-sign` to `steve_sociall` from that other account instead of sending
`!break`. Whispers depend on Twitch's sender verification and delivery rules.
An enum whisper starts one round immediately when idle. Invalid enum guesses and
free text are ignored. Each viewer has a 60 s start cooldown, and a new round must
wait for the active round's recording to finish.

The overlay should show head start, Pit Crew activity, real validation frames,
then the autopsy with headline, colored diff excerpts, GREEN split and `+1 test`.
The terminal prints the sanitized receipt under `docs/rounds/`; the credited
regression goes under `chat-found/`. Public records keep hashed viewer labels.
The live overlay and chat use display names.

Chat replies are sent while offline. Markers, clips and the autopsy pin each check
Get Streams and are skipped while offline. If Twitch refuses a live action, the
reason is retained in the private `twitch.jsonl`; it does not fail the round.
A clip acceptance is a request receipt, not proof the clip was published.
`pnpm round:live --dry-chat` listens and runs real repairs but only logs outgoing
lines, with all Twitch writes disabled. It is not a model-free rehearsal.

## Import OBS and play

1. In OBS, use **Scene Collection > Import**, select
   [`obs/chat-vs-codex.scene.json`](../obs/chat-vs-codex.scene.json), import it,
   then select the **Chat vs Codex** collection.
2. In **Settings > Video**, set **Base (Canvas) Resolution** and
   **Output (Scaled) Resolution** to **1920x1080**, and **Common FPS Values** to
   **60**. The collection has a 1920x1080 scene and a browser source configured for
   60 fps; OBS's output resolution and frame rate belong to the selected profile
   and are not changed by a scene import.
3. Start `pnpm round:live`. The **Chat vs Codex Game** browser source uses the same
   loopback URL the runner prints. If it was loaded before the server started,
   right-click it, open **Properties**, and **Refresh cache of current page**.
   Keep **Shutdown source when not visible** and **Refresh browser when scene
   becomes active** off so scene changes preserve the game.
4. Select **Chat vs Codex Game** and click **Interact** (or right-click >
   **Interact**). Focus that window. Use **Left/Right arrows** to run, **Space** to
   jump, and **R** to restart after a death or goal. Play in this Interact window:
   it controls the exact browser source viewers see. A separate browser preview
   has its own player state. Keep Interact open and focused during play.
5. Confirm the OBS preview responds to those keys and the HUD fits at 720p before
   recording. Do a local recording and inspect playback. Do not claim live
   delivery, clip publication or encode performance from fixture tests.

The scene collection contains no account or service configuration. Regenerate
it with `pnpm obs:scene`; `pnpm obs:scene --check` verifies it still matches the
shared runner URL. Tests verify the serialized source references, dimensions,
frame rate and freshness. Import and keyboard interaction still need the OBS
check on the presenting machine.

[OBS scene collection import](https://obsproject.com/kb/scene-collections) and
[browser source settings](https://obsproject.com/kb/browser-source) describe these
controls.

## Connect the stream account

The streamer performs this step: in **OBS Settings > Stream**, choose **Twitch**,
then **Connect Account (recommended)** and complete Twitch sign-in. Do not paste,
request or store a stream key in this repository. The round runner does not start
a broadcast. Leave **Start Streaming** for the streamer to press after the offline
round and OBS input checks pass. Twitch documents
[Connect Account](https://help.twitch.tv/s/article/multiple-encodes).

In **Twitch Creator Dashboard > Settings > Stream > Stream Key & Preferences**,
set **Latency mode > Low latency**. Keep **OBS Settings > Advanced > Stream Delay**
disabled for the chat race. The visible 15 s head start is part of the product;
neither latency mode nor the runner promises zero delivery delay. See Twitch's
[low latency guide](https://help.twitch.tv/s/article/low-latency-video).
