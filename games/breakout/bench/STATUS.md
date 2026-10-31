# Breakout runtime benchmark

Three total `gpt-6.1-terra` low trials are approved, selecting different pool
families. No scored trials have started. The one dry-run invocation stopped at
the mandatory clean-source preflight, before an SDK thread started:

```text
sandbox-exec: sandbox_apply: Operation not permitted
```

The [retained preflight log](runs/preflight-4303479a-71d9-4fbd-baa7-6eaef49f9631.jsonl)
records the real validator, unchanged permission profile and workspace-local
TMPDIR. This is an environment refusal, not a repair result. No retry or
permission change was attempted.

From a normal terminal with the existing ChatGPT sign-in:

```sh
CI=true pnpm ci:local
pnpm breakout:bench --plan
pnpm breakout:bench --run
pnpm breakout:bench --summary
```

The batch performs the same clean sandbox preflight, then exactly three trials
without retry. Commit its resulting JSONL and run logs before rebuilding the
judge site. Pool gates and fake-CLI integration tests do not establish a real
model fix rate.
