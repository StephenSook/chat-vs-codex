# Chat-found regressions

Each verified round can add one replay test, credited to its round ID and a private
viewer alias. Records retain the canary inputs, clean expectations, the original
planted mutant's bounded replay trace, and a checkpoint at the first divergent
frame. If the canary survives without distinguishing the bug, one separately
identified failing route supplies the witness within the same test.

The [first record](65e06ea8-d2bd-4e40-9ec7-79f4318c2b02.json) was reconstructed
after the first completed fixture round. Its clean and broken browser hashes
match that round's private logs and [public receipt](../docs/rounds/65e06ea8-d2bd-4e40-9ec7-79f4318c2b02.json).
The original mutant survives all 1,200 canary frames and first diverges from the
clean build at frame 48. `retroactive: true` distinguishes this later replay from
the original recorded round; its original overlay did not display a test credit.

Future runtime workspaces receive only neutral inputs and expectations, before
their single commit. Attribution, original mutant data and buggy traces stay
outside the SDK workspace. The visible validation suite includes one test per
record. The runtime and offline pool gate exclude exact learned mutation
fingerprints for the same source version, while retaining every other gate.

Writes are atomic and idempotent for the same credit. The autopsy shows `+1 test`
only after persistence succeeds. JSON formatting is kept stable because the
receipt binds the saved file's bytes; schema and replay checks still run in CI.
