# One outside user, two UI changes

On 2026-10-31, Blucca reported recomputing round `c81bdc19` on the hosted judge
site: MATCH, 600 frames. The [public Devpost thread](https://twitchcon-codex.devpost.com/forum_topics/45671)
and written permission to credit Blucca were supplied by Stephen.

Blucca asked for the race result beside GREEN and a labelled BROKEN / FIXED view.
The repository now shows the recorded winner, first correct guesser and head start
beside GREEN, with the rule sequence first. The comparison re-simulates identical
inputs against the exact original and repaired builds, opening at a visibly
divergent frame. Original trace checks and the separate 600-frame receipt proof
remain required; missing evidence shows unavailable.

This is feedback from one outside user, resulting in two UI changes. Unit checks
and the static build pass. Stephen will run the browser smoke and redeploy;
post-change feedback from Blucca has not been collected.
