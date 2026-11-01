# Pit Wall changes

## Native build 3

Advance the iOS build number and Android version code to 3 for the layout fix.
Verification: `pnpm ci:local` and the explicit build counters in `app.json`.
EAS builds and TestFlight device verification remain outside the sandbox.

## Live-round layout

Stephen's build 2 iPhone recording showed controls overflowing a 402x874-point
viewport. Compact cards and three fixed hint rows keep the score, status, veto
and six hints visible. Forget pairing hides during live rounds and returns
afterward. The scroll container owns safe-area padding, including its bottom edge.

Verification: `pnpm exec vitest run apps/pit-wall/test/layout.test.ts` measures
the actual screen tree with Yoga and conservative text heights. It checks the
Dynamic Island viewport, bottom insets, scroll reachability and action callbacks.
`pnpm ci:local` checks types, lint, tests and both phone bundles.
