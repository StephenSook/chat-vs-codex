# Channel Points

Start the normal listener from a terminal outside the build sandbox:

```sh
pnpm --filter @chat-vs-codex/overlay build
pnpm round:live
```

Startup tries to create **Break the game**, cost **100**, no user input, with the
request queue enabled. The terminal prints Twitch's exact response status and
body, also retained in the private `.local/round-runs/<run>/twitch.jsonl` log.
Access tokens stay in headers; reflected access tokens are redacted. Do not
publish these logs: reward responses and redemption records can contain user IDs.
An existing reward created by this app is reused on restart after Twitch confirms
ownership with `only_manageable_rewards=true`.

On HTTP 403, the listener discovers the enabled dashboard reward with the same
title, cost and no-input setting. If none exists, open the Creator Dashboard:
**Viewer Rewards > Channel Points > Manage Rewards & Challenges**, then restart
the listener. An unavailable or ambiguous reward disables Channel Points without
disabling `!break`.

Redeem **Break the game** from another viewer account when idle. It starts the
same round as `!break`, with the same cooldown, secret selection, head start and
repair gate. No redemption text becomes a Codex prompt. After the round ends,
look for `twitch.reward-settled` with `FULFILLED` in the private log. A failed
Codex repair still fulfills a round that ran. A round that could not install its
broken build, including a busy/cooldown rejection, is canceled and refunded only
when this app owns the reward. Duplicate events do not repeat a round or update.

Dashboard rewards are consume-only: Twitch permits only the creating app to
[update redemption status](https://dev.twitch.tv/docs/api/reference/#update-redemption-status).
For an unfulfilled dashboard redemption, the listener logs
`twitch.reward-manual-settlement` with the requested status. The broadcaster must
fulfill or refund it in the dashboard request queue; the app cannot perform that
update. Already fulfilled redemptions require no second settlement. Refused
updates retain the exact provider response and do not turn a completed round
into a failure.

```sh
pnpm round:live --dry-chat
```

This discovers existing rewards and logs settlement intentions without creating
or updating rewards or sending any other Twitch writes. It can still run real
Codex repairs after an accepted input. Stop with Ctrl+C when verification ends.

Fixture-driven checks make no live Twitch calls:

```sh
pnpm exec vitest run packages/twitch/test/rewards.test.ts packages/round/test/rewards-live.test.ts
```
