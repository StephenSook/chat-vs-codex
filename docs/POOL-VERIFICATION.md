# Platformer pool verification, 2026-10-31

`pnpm mutator:pool` ran once on the merged Pit Wall tree, before merge commit
`2417f3914861fd30c35c2403f1723df524aa509e`. Regeneration was required there so
the merge's CI gate could check the new lockfile binding.

Result: **160 candidates gated, 53 accepted**. Every pooled mutant and its gate
evidence are identical to the pre-merge pool at
`d88b3c57100e8d8e2679e6513ad10b9862b1890a`. The only changed pool field is
`sourceDigest`, because the digest includes `pnpm-lock.yaml` and the mobile
workspace added dependencies. The simulation, authored replay inputs and goldens
did not change.

- Previous source digest: `15c55beb43dafa38bab1222689967fe06a86beb299118a2b27f990200ec0817e`.
- Merged source digest: `2ea4c9948b2b8d8ef3cd5357aff59a1a1ec4c5911d5d1772c4047280fb4e7b6f`.
- Pool file SHA-256: `985f1a6a132867f24f5e547307359118adeb97f29951405d1c68bdf5fe9d560b`.

Acceptance retained typechecking, different minified output, a killed replay,
visible divergence, bounded replay execution and 1,200 surviving canary frames
(20 seconds). The frame cap is 3,600 and the replay process budget is 3,000 ms.
Triage artifacts were rebound to the new pool digest without changing predictions
or metrics. Subsequent judge-site changes leave the gate inputs unchanged.

Verify the current source binding and pooled evidence without regenerating:

```sh
pnpm exec vitest run packages/mutator/test/pool.test.ts packages/mutator/test/pool.integration.test.ts
```
