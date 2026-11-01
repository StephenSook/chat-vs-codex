# Pit Wall changes

## Live-round layout

Stephen's build 2 iPhone recording showed controls overflowing a 402x874-point
viewport. Compact cards and three fixed hint rows keep the score, status, veto
and six hints visible. Forget pairing hides during live rounds and returns
afterward. The scroll container owns safe-area padding, including its bottom edge.

Verification: `pnpm exec vitest run apps/pit-wall/test/layout.test.ts` measures
the actual screen tree with Yoga and conservative text heights. It checks the
Dynamic Island viewport, bottom insets, scroll reachability and action callbacks.
`pnpm ci:local` checks types, lint, tests and both phone bundles.
