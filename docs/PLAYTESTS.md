# Playtest sessions

Times are local to America/New_York. Stream status and participants come from
Stephen's session notes; outcomes and bug families come from the linked receipts.
No viewer naming permission was supplied, so participants are anonymous.

| Session                                                         | Who was in chat                           | What broke                                               | Winner                                                                                        | Receipts                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Oct 31, 2026, live from 14:31 EDT (TEST)                        | Streamer using a test account             | collision-off-by-one; enemy-ledge-turn; swapped-controls | Codex in three rounds; no awarded winner for the later round-limit repair                     | [382e1376](rounds/382e1376-4d6e-477a-86b8-5ceffe629f43.json), [dbf91971](rounds/dbf91971-4ef0-4f39-9a90-d84d14a5535c.json), [b403faf1](rounds/b403faf1-abc9-4c89-9a2a-c3a67fd4d105.json), [c37736fc](rounds/c37736fc-52d2-4ca0-9eee-dae78a5eff7b.json) |
| Oct 31, 2026, 21:37 EDT (TEST; channel live state not attested) | Broadcaster test account                  | gravity-sign                                             | Codex, GREEN 28.93 s                                                                          | [8a34be05](rounds/8a34be05-c8b6-45b1-b8ee-a04735d68cc4.json)                                                                                                                                                                                           |
| Nov 1, 2026, live 12:55 to 13:30 EST                            | A viewer; streamer started the boss round | gravity-sign; collision-off-by-one                       | Chat won the viewer race; Codex still repaired in 28.47 s. Terra won the boss race in 22.09 s | [ac8b50c7](rounds/ac8b50c7-1012-4f20-af7e-10dd718b9f1c.json), [d4c4ec5f](rounds/d4c4ec5f-b7e8-420e-bb16-91df94677f09.json)                                                                                                                             |

The [operator note](round-notes.json) identifies the streamer-started boss round
without altering its recorded receipt. Season totals keep viewer, boss and TEST
rounds separate. A completed repair after the round limit is not a race win.
Older offline checks and local fixtures remain in [round receipts](rounds/).

## Pit Wall on a real iPhone

Stephen verified TestFlight pairing, a full round, the notification banner and
haptic on Oct 31. On Nov 1, TestFlight build 3 verified the no-scroll layout,
banner, haptic and lock-screen Live Activity with score, last result and deaths.
These checks cover one iPhone. Android native compilation was verified through
EAS; Android physical-device behavior has not been verified.
