# Game Inspector

Runtime rounds register three read-only MCP tools:

- replay_frames(track, from, to): at most 30 inclusive original-buggy frames.
- first_divergence(track): first differing player/enemy field and its values.
- diff_telemetry(track, frame): golden and original-buggy values at one frame.

Positions and velocities use Q8 fixed point, 256 units per pixel, at 60 Hz.
Recordings stay fixed after edits. Tracks have neutral names replay-01 through
replay-07. Unknown names, paths, extra fields and invalid windows are refused.
No tool executes source, reads a caller-selected file, or exposes the held-out
track, clean TypeScript, viewer identity or mutation metadata.

Before the trial's single initial commit, the host captures only its byte-verified
trusted pool candidate in a three-second bounded worker. It writes telemetry
and the dependency-free bundled stdio server into fixtures/inspector. Those files
are read-protected by the existing hotfix profile and included in the immutable
source guard. Runtime SDK configuration starts the server through an explicit
Codex sandbox command. Its workspace permission is read instead of write; the
root and temporary-directory denies and network disable stay intact. A required
server startup fails the repair instead of silently dropping the Inspector.
Historical benchmark trials keep their original configuration without Inspector.

The newline JSON-RPC session supports MCP initialize/initialized, ping, tools/list
and tools/call. Requests have a 32 KiB limit and replies a 64 KiB limit.

Run the protocol and wiring checks:

    pnpm exec vitest run packages/inspector-mcp packages/bench/test/inspector.integration.test.ts

The wiring fixture runs the real SDK against a fake CLI, starts this actual stdio
server, records an MCP item before its test patch, then passes typecheck, every
visible replay and the held-out route. Its policy adapter checks sandbox arguments
but provides no OS isolation. It spends no model tokens and is not evidence of a
real model choosing this tool. A real Inspector round and a with/without timing
comparison remain measurements to collect; existing benchmark figures predate it.

The SDK's configOverrides supply the command/args configuration described in the
[Codex MCP documentation](https://developers.openai.com/codex/mcp/).
