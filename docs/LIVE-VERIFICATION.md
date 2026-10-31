# Live verification, 2026-10-31

All three rounds below were **TEST** rounds with `--allow-broadcaster-test`.
They demonstrate live Twitch input and repair, not viewer participation.
Input paths are Stephen's run notes; these original receipts predate the `input`
field and are retained unchanged.

| Receipt                                                      | Input                              | Revealed family      | GREEN   |
| ------------------------------------------------------------ | ---------------------------------- | -------------------- | ------- |
| [382e1376](rounds/382e1376-4d6e-477a-86b8-5ceffe629f43.json) | Chat `!break`                      | collision-off-by-one | 0:25.76 |
| [dbf91971](rounds/dbf91971-4ef0-4f39-9a90-d84d14a5535c.json) | Channel Points, "Break the game"   | enemy-ledge-turn     | 0:31.16 |
| [b403faf1](rounds/b403faf1-abc9-4c89-9a2a-c3a67fd4d105.json) | Secret whisper, `swapped-controls` | swapped-controls     | 0:42.24 |

Stephen verified the reward redemption was FULFILLED through Twitch's API.
Each round created a bug-in marker, a fix-landed marker, a published clip and an
autopsy pin while the channel was live. These Twitch side effects are operator
observations, not fields inferred from the receipts.

The whisper arrived only after the receiving channel accepted whispers from the
sender. Check Twitch's "Block Whispers from Strangers" setting before testing;
the sender must also meet Twitch's phone-verification requirements.

The stream used OBS hardware encoding and reported zero dropped frames. The
idle player died immediately in these runs, making the symptoms hard to distinguish.
These receipts preserve that run history; presentation fixes do not alter it.
