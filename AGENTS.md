# Repository guidance

- TypeScript everywhere, Node 22, pnpm workspaces, Vitest, strict TypeScript.
- Keep the pure simulation core below about 1,500 lines. No DOM imports.
- Every behavior change ships with a test.
- Never use Math.sin, Math.cos, Math.pow or Math.random in simulation code.
  Use integer or fixed-point math, and pure-rand with explicit seeded state.
- World state is never a mutation site. Only mutate paired @hotfix-site regions.
- Use small atomic commits with clear messages. Push after each commit.
- Use Stephen Sookra's configured Git identity. Never add Co-Authored-By or
  other AI attribution lines to commits or PRs.
- Never commit secrets. Keep dependencies, dist, .env files, bench/tmp, film
  and logs ignored. Benchmark event JSONL and results JSONL are evidence to retain.
- Run pnpm ci:local before committing: frozen install, typecheck, lint, test.
- The repository is public by Stephen's decision. Never change visibility or
  collaborators. Never run gh repo edit. Never commit secrets.
- Read files before editing. Stage named paths and verify committed content.
- Runtime trials must use neutral isolated directories with logs outside them,
  immutable tests and fixtures, and no access outside the runtime workspace.
- Ask Stephen to approve the planned benchmark trial count before runtime trials.
