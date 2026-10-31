# Twitch authorization and EventSub check

Verified on 2026-10-31 at 06:06 UTC against Twitch's real Validate Token endpoint.
Login: `steve_sociall`. The Client ID and user ID matched the device grant, and
the scope set exactly matched these 11 requested scopes:

```text
bits:read
channel:manage:broadcast
channel:manage:redemptions
channel:read:hype_train
channel:read:redemptions
clips:edit
moderator:manage:chat_messages
moderator:read:followers
user:read:chat
user:read:whispers
user:write:chat
```

Tokens were saved only in ignored `.local/twitch/tokens.json`, file mode 0600.
No token values are included in this receipt. At validation the access token had
13,157 seconds remaining. Only token lengths and expiry were logged.

One real EventSub WebSocket registered the following subscriptions for the
authorized broadcaster, then closed. Each returned status `enabled`, cost 0.

| Subscription                                        | Status  | Cost |
| --------------------------------------------------- | ------- | ---: |
| channel.chat.message                                | enabled |    0 |
| user.whisper.message                                | enabled |    0 |
| channel.channel_points_custom_reward_redemption.add | enabled |    0 |
| channel.custom_power_up_redemption.add              | enabled |    0 |
| channel.bits.use                                    | enabled |    0 |
| channel.raid                                        | enabled |    0 |
| channel.hype_train.begin (v2)                       | enabled |    0 |
| channel.hype_train.progress (v2)                    | enabled |    0 |
| channel.hype_train.end (v2)                         | enabled |    0 |

Total cost: **0**. This verifies subscription registration, not delivery of a live
chat event or a live-stream game round. No chat messages, rewards, clips, stream
markers or pins were created during this check.
