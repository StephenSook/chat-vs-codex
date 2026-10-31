/** CI test double: checks sandbox arguments but provides NO OS isolation. */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

declare const CALLS_FILE: string;
const args = process.argv.slice(2);
const boundary = args.indexOf("--");
const profile = args.filter((_, index) => args[index - 1] === "-c");
const inspection = args[boundary + 2]?.endsWith(
  "/fixtures/inspector/server.mjs",
);
if (
  args[0] !== "sandbox" ||
  boundary < 0 ||
  args[boundary + 1] !== process.execPath ||
  args[args.indexOf("--permission-profile") + 1] !== "hotfix"
)
  process.exit(81);
const joined = profile.join("\n");
for (const path of [":root", "/tmp", "/private/tmp", "/private/var/folders"])
  if (!joined.includes(`"${path}" = "deny"`)) process.exit(82);
if (
  !joined.includes("enabled = false") ||
  !joined.includes(
    `":workspace_roots" = { "." = "${inspection ? "read" : "write"}"`,
  )
)
  process.exit(83);
appendFileSync(
  CALLS_FILE,
  `${JSON.stringify({ inspection, profile, args })}\n`,
);
const child = spawnSync(args[boundary + 1] ?? "", args.slice(boundary + 2), {
  cwd: args[args.indexOf("--cd") + 1],
  env: process.env,
  stdio: "inherit",
  timeout: 10000,
});
process.exit(child.status ?? 84);
