# Publish a night's regression replays

After verified rounds leave new files in `chat-found/` and matching sanitized
receipts in `docs/rounds/`, run:

```sh
pnpm chat-found:pr
```

The script verifies the replay proof, hashed viewer credit and receipt digest.
It fetches `origin/main`, creates an isolated worktree, runs `pnpm ci:local` and
a staged secret scan, commits the new evidence and its regenerated season
scoreboard, pushes a new branch and opens one pull request listing its rounds.
Git, pnpm, gitleaks and authenticated
`gh` must be available. It uses the configured Git author and never merges.

The original branch, staged changes and new evidence remain untouched. Repeating
the same batch returns its existing open pull request. A failed gate leaves no
local batch branch lock. If a push landed before PR creation failed, retry checks
the remote commit's exact base, file set and evidence bytes, reruns CI and reuses
that commit without a force push. A changed remote base or evidence is refused.
Existing evidence cannot be modified. No new regression files means refusal
before any network call.
If a gate fails, the script retains its worktree under `.local/chat-found-pr-*`
for inspection and prints the path.

For a manual evidence commit, run `pnpm season:record` and include `docs/season.json`.
CI runs `pnpm season:check` before the test suite. The PR script does this
inside its isolated worktree.
