# Twitch panel setup

Status: implemented and fixture-tested. Hosted Test and review submission have not been verified. Do not describe the panel as available or in review until the corresponding console transition is complete.

The static panel shows the score, measured head-start deadline, latest observed Codex step, and viewer-only season totals. Broadcaster tests are labelled TEST. It requests no viewer identity and contains no credentials. Its UI uses Twitch's hosted Extension Helper and only listens to the channel's broadcast topic.

The host projects the real round event bus through an explicit public allowlist. `/api/public-state` exposes the same projection on the existing localhost server, while the optional host publisher transports snapshots through Twitch Extension PubSub. Season totals come from the same committed receipts and aggregation used by the judge site. No local server is exposed publicly. Snapshots repeat at most once per second so late joiners receive current state; repeated snapshots never create Codex activity. After ten seconds without a current snapshot, the panel says "Waiting for round data".

## Hosted Test

1. In the [Twitch developer console](https://dev.twitch.tv/console/extensions), create or select the **Chat vs Codex** Extension, version 0.0.0, with a **Panel** view, viewer path `index.html`, and height 350. Turn identity linking, Bits, chat capabilities and mobile support off. This Extension has its own Client ID and base64 shared secret, separate from the chat application's OAuth Client ID. Also note the numeric Twitch user ID of the Extension owner; it may differ from the channel broadcaster.
2. Build the upload from the repo root:

   ```sh
   pnpm --filter @chat-vs-codex/extension package
   ```

   The ZIP is `.local/extension/chat-vs-codex-panel.zip`. It contains only built static assets, with `index.html` at its root. The packaging guard refuses local host wiring and credential references. Do not upload source directories or any `.local/` directory.
3. Upload that ZIP under Files / Version Assets. Add `steve_sociall` to the Streamer Allowlist and the Testing Account Allowlist. Move the version to **Hosted Test**, then install and activate the panel from the channel's Creator Dashboard Extension Manager.
4. Store the Extension shared secret in macOS Keychain or the host's secret store. Supply the runner with `EXTENSION_ENABLED=1`, `TWITCH_EXTENSION_CLIENT_ID`, `TWITCH_EXTENSION_OWNER_ID`, and `TWITCH_EXTENSION_SECRET` from that store. Never put the secret in a `VITE_*` variable, console screenshots, a URL, or an uploaded asset. `TWITCH_EXTENSION_OWNER_ID` is the public numeric ID of the account that owns the Extension. The broadcaster ID comes independently from the already validated live account. The JWT `user_id` is the Extension owner; its `channel_id` and the API body's `broadcaster_id` remain the validated broadcaster.
5. Run the existing live runner outside the sandbox. Verify panel snapshots return HTTP 204 in the private host log, the panel updates from a real labelled test round, and the season excludes test wins. Close the runner and verify the panel becomes stale within ten seconds. A 401 or 403 is logged by numeric status only; it cannot fail a game round.

Only this fixture stage has run in this build thread. The actual developer-console Extension ID, shared secret, allowlists, asset upload, installed channel panel and a screenshot are needed to mark Hosted Test verified.

## Review

After Hosted Test is verified, submit the same uploaded version for review in the console. Complete the name, summary, description, author/contact metadata, category, logo (100x100 PNG), discovery image (300x200 PNG), real panel screenshot (minimum 1024x768, 4:3), privacy-policy URL and terms URL. These human/account and legal fields are intentionally not invented. Review channel: the broadcaster's real Twitch channel. In the walkthrough explain that the live host supplies game state and arrange a review time if needed. The status may be described as **in review** only after Twitch confirms that transition; approval remains separate.

Review walkthrough: install the panel, start a labelled test round with the existing `!break` route, observe the real head-start countdown and SDK step, verify score after resolution, compare the viewer-only season against the judge site's season card, then stop the runner and observe the stale state.

## Checks

```sh
pnpm exec vitest run packages/round/test/public-state.test.ts packages/round/test/extension-publisher.test.ts apps/extension/test/panel.test.ts
pnpm --filter @chat-vs-codex/extension package
```

No live Twitch calls run in these fixtures. The publisher has one in-flight request, a ten-second abort and a one-second minimum interval. Its JWT expires after sixty seconds, uses the base64-decoded shared secret with HS256, and grants `external` role only for this broadcaster's `broadcast` topic. Responses are reduced to numeric status; neither the JWT nor remote bodies enter logs.

Sources: [Twitch Extension Helper and JWT schema](https://dev.twitch.tv/docs/extensions/reference/), [Send Extension PubSub Message](https://dev.twitch.tv/docs/api/reference/#send-extension-pubsub-message), [Extension lifecycle and Hosted Test](https://dev.twitch.tv/docs/extensions/life-cycle/). Hosted Test is allowlisted; review and approval are distinct stages.
