# Local round verification status

Stephen completed a real fixture round outside the build sandbox on 2026-10-31.
The [sanitized receipt](rounds/65e06ea8-d2bd-4e40-9ec7-79f4318c2b02.json)
records the verified gravity fix despite a wrong enum hint, full replay and held-out
validation, preserved game state during replacement, and CODEX 1. The private
source evidence remains under `.local/round-runs/`. This round predates monotonic
phase stamps: missing durations are unavailable, not reconstructed from the late
legacy `validating` event. New rounds record actual runtime boundaries.
Its [regression replay](../chat-found/65e06ea8-d2bd-4e40-9ec7-79f4318c2b02.json)
was generated afterward from the original pooled mutant, with both browser
build hashes matching the returned evidence. The real canary survives 1,200
frames and diverges at frame 48. This is marked retroactive; the original
recorded overlay had no autopsy, ghost or `+1 test` badge.

The autopsy implementation has contract, reducer, safe DOM rendering and local
integration coverage. A single Playwright attempt in the build sandbox stopped
at Chrome launch (`SIGABRT`, with `kill EPERM` during cleanup), before any page
assertion. Its new pixels and OBS appearance remain for the next outside-sandbox
round. The temporary preview server was closed after this attempt.

The following earlier attempt records the build sandbox's refusal, not the
subsequent successful round.

Implementation commit: `e5c376f0e53bc01ccb4249655e5e006b62d7d2df`.
Attempted on 2026-10-31 at 06:35 UTC with `pnpm round:fixture --run`.

The clean-source preflight stopped before any model thread, head-start timer or
broken-build activation. Its first TypeScript validation command exited **71**:

```text
WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)
sandbox-exec: sandbox_apply: Operation not permitted
```

The OS refused nested sandbox application. No retry or permission change was
attempted. This is neither a green round nor a Codex repair loss. No benchmark
results were changed. Runtime model calls in this attempt: **0**.

The original preflight JSONL is retained privately under ignored
`.local/round-runs/126f664e-b577-4495-8a3f-b20a5a9b1d69/`, named
`preflight-1defc64b-1434-45f1-b220-953709af6bdc.jsonl`.

Local frozen install, strict typecheck, lint and **204 tests** pass. The production
overlay build passes. The end-to-end integration test exercises the real Twitch
fixture handler, round engine, Node replay commands, HTTP artifacts and live-state
game client, with explicit repair and sandbox-policy test doubles. It establishes
those component seams, not a real SDK fix or OS permission enforcement.
GitHub CI and Socket checks passed for the implementation commit.

Run one real fixture round from a normal terminal using Node 22 and the existing
ChatGPT sign-in. The command retains the exact hotfix profile and all temp-dir
denies, performs the clean preflight, then permits one Terra-low SDK repair:

```sh
CI=true pnpm ci:local && pnpm --filter @chat-vs-codex/overlay build && pnpm round:fixture --run --serve
```

The runner prints its new private log directory and overlay URL. `--serve` keeps
the local overlay available after the round; Ctrl+C closes it. It does not start
a Twitch listener or send chat. Return the resulting private round logs and
receipt for the next round's visual and timing verification.
