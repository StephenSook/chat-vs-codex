# The proof room

A static Vite site. No application server, sign-in or keys.

```sh
pnpm judge:build
pnpm judge:preview
pnpm judge:smoke
```

Publish the contents of `apps/judge/dist/` to any static host. The build reads
evidence from one pinned Git HEAD, not the working tree. Commit new public round
receipts and regressions before rebuilding. A shallow clone reports only the
reachable commit graph; use a full clone for the complete count.

The browser recomputes benchmark metrics with the benchmark's shared statistics
module, retaining infrastructure losses. Each round keeps its fixture, viewer or
broadcaster-test label. Raw receipts and credited regressions are downloadable.

Re-simulation verifies the bundled simulation's SHA-256 before importing its exact
bytes, runs the committed held-out track and compares every frame's combined
SHA-256 with the recorded receipt. A missing patched artifact or legacy frame
digest is reported as unavailable. Matching a final outcome alone never counts
as a proof. This verifies deterministic playback, not Twitch delivery or timing.

The sandbox card derives a sanitized receipt from matching successful SDK and
kernel probe output, including positive controls and the in-workspace temporary
directory. Runtime logs and private round data are never scanned or bundled.

`pnpm judge:smoke` builds the site, starts `vite preview`, runs Playwright and
closes the preview. No Twitch or Codex calls occur.
It uses installed Google Chrome. Run it from a normal terminal if a nested
macOS sandbox prevents Chrome from launching. A launch failure fails the check.
