# Breakout runtime benchmark

The approved batch is complete: [summary and limits](SUMMARY.md). It retained
three total `gpt-6.1-terra` low trials, one per selected site, without reruns.

The earlier sandbox dry-run invocation stopped at
the mandatory clean-source preflight, before an SDK thread started:

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

The [retained preflight log](runs/preflight-4303479a-71d9-4fbd-baa7-6eaef49f9631.jsonl)
records the real validator, unchanged permission profile and workspace-local
TMPDIR. This is an environment refusal, not a repair result. No retry or
permission change was attempted.

Recompute the committed evidence without starting a model:

```sh
pnpm breakout:bench --summary
```

The successful batch's clean preflight, manifest and every trial log are retained
beside the earlier refusal. Additional model trials require separate authorization.
