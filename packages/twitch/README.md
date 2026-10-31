# Twitch foundation

Pinned Twurple 8.2.0 device authorization, one broadcaster=bot EventSub WebSocket,
typed intents, and offline fixtures. The round engine adapter is not attached.
Receiving an intent does not claim a bug was injected, a guess scored, or a fix landed.
No clips, markers, pins or rewards are created by these commands.

Set the public application Client ID as `TWITCH_CLIENT_ID`. No client secret is used.
Start authorization and stop for the human to approve Twitch's verification page:

```sh
pnpm --filter @chat-vs-codex/twitch auth start
```

After approval, resume polling with `auth resume`. The pending device grant is
stored in the repository's ignored `.local/twitch-device.json` with mode 0600.
Access and refresh tokens go to `.local/twitch/tokens.json` inside the workspace, mode 0600,
with a 0700 parent directory. Refreshes replace that file atomically.
Device start, exchange and validation each have a 20-second request deadline.
Polling also cancels an in-progress request when the device grant expires.
Twurple's high-level OAuth helpers do not expose an AbortSignal, so a small Node 22
fetch helper supplies cancellation through response body reads. The exchanged
token is validated against the Client ID, user and granted scopes before saving.
Runtime token refresh still uses Twurple's RefreshingAuthProvider.
`listen` starts inbound subscriptions only. It prints public intents and withholds
private selections. `listen --record .local/twitch-recording.jsonl` records
anonymized payloads with a random HMAC key per recording session.

```sh
pnpm --filter @chat-vs-codex/twitch replay fixtures/session.json
```

Fixtures are hand-authored examples in the exact external data types inferred from
Twurple's `DataObject` classes. Real callbacks use `getRawData` and the same handler.
Fixtures demonstrate routing, not a live Twitch test. The recorder hashes identifiers
and names and redacts free text, including whispers and reward input, before saving.
Review recordings before committing; they are never automatically added to Git.

Only bare `!break` triggers a public break request. `!guess <word>` and `!hint`
become intents. A recognized bug-family whisper goes only to the private sink.
Raids request two bugs. Hype levels 1, 2 to 4, and 5 or higher map to severity
tiers 1, 2 and 3; end resets tier 1. These are local product rules.

Chat message and Shared Chat source IDs are deduplicated. Twurple itself deduplicates
WebSocket transport message IDs before its callbacks (EventSubBase 8.2.0).
Bits-use payloads have no custom-redemption correlation ID in 8.2.0, so only the
custom-power-up subscription can request a Chaos break. Overlapping Bits power-up
events are ignored in either order. Price/time matching would merge real purchases.
Configure reward and power-up IDs in the handler before enabling those paths.
Public power-up input is ignored and never interpreted as a secret.

`chooseReward` is an injected capability helper for the later reward setup step:
an explicit create succeeds as app-owned/refundable; only the documented 403
"not a partner or affiliate" permits dashboard consume-only fallback. It logs the
selected path. The CLI does not call this helper or create anything during auth.

API signatures verified from the published 8.2.0 package type definitions and source.
Live behavior, account eligibility and the final round loop require the authorized
Twitch account and are not established by fixture tests.
