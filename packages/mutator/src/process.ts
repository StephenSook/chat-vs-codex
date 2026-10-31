import { spawnSync } from "node:child_process";

export function runBounded(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): string {
  const result = spawnSync(command, args, {
    cwd,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new Error(
      JSON.stringify({
        command,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stderr: result.stderr,
        stdout: result.stdout,
      }),
    );
  }
  return result.stdout;
}
