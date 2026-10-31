import { fork } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth, readToken, SCOPES } from "../../twitch/src/auth.js";
import { createLiveHelix, type LiveHelix } from "../../twitch/src/helix.js";

export interface TitleWatchdog {
  cancel(): Promise<void>;
  restore(): Promise<void>;
  shown(): Promise<void>;
}

/** A finite watchdog owns its 60 s deadline and survives the runner's termination. */
export function armTitleWatchdog(options: {
  journalPath: string;
  lease: string;
  broadcasterId: string;
  accessToken?(): Promise<string>;
  onRestored?(): void;
  onFailure?(): void;
}): Promise<TitleWatchdog> {
  return new Promise((done, reject) => {
    const child = fork(
      fileURLToPath(new URL("./title-watchdog.ts", import.meta.url)),
      [options.journalPath, options.lease, options.broadcasterId],
      {
        execArgv: ["--import", "tsx"],
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let ready = false;
    let exited = false;
    let shownAck: (() => void) | undefined;
    let outcome: "restored" | "failed" | "canceled" | undefined;
    const timer = setTimeout(
      () => fail(new Error("Title watchdog did not arm")),
      5_000,
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      if (!ready) {
        child.kill();
        reject(error);
      }
    };
    const stopped = new Promise<void>((resolve) =>
      child.once("exit", () => {
        exited = true;
        resolve();
        if (ready && outcome !== "restored" && outcome !== "canceled")
          options.onFailure?.();
        fail(new Error("Title watchdog exited before arming"));
      }),
    );
    child.once("error", fail);
    async function request(action: "restore" | "cancel") {
      if (!exited) {
        if (child.connected) child.send(action, () => {});
        // Refresh + validation + Helix each have request bounds. If the child
        // becomes unresponsive, kill and await it before any parent fallback.
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              void stopped.then(resolve);
            }, 55_000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
      }
      if (action === "restore" && outcome !== "restored")
        throw new Error("Title watchdog did not acknowledge restoration");
    }
    child.on("message", (message: unknown) => {
      if (message === "shown") {
        shownAck?.();
        return;
      }
      if (message === "token-request") {
        const token =
          options.accessToken?.() ??
          Promise.reject(new Error("Parent authorization unavailable"));
        void token
          .then((value) => {
            if (child.connected)
              child.send({ type: "title-token", value }, () => {});
          })
          .catch(() => {
            if (child.connected)
              child.send({ type: "title-token-refused" }, () => {});
          });
        return;
      }
      if (
        message === "restored" ||
        message === "failed" ||
        message === "canceled"
      ) {
        outcome = message;
        if (message === "restored") options.onRestored?.();
        return;
      }
      if (message !== "ready" || ready) return;
      ready = true;
      clearTimeout(timer);
      child.unref();
      child.channel?.unref();
      done({
        cancel: () => request("cancel"),
        restore: () => request("restore"),
        shown: () =>
          new Promise<void>((resolve, reject) => {
            if (exited || !child.connected) {
              reject(new Error("Title watchdog is unavailable"));
              return;
            }
            const timeout = setTimeout(() => {
              child.kill("SIGKILL");
              void stopped.then(() =>
                reject(new Error("Title watchdog did not acknowledge display")),
              );
            }, 5_000);
            shownAck = () => {
              clearTimeout(timeout);
              shownAck = undefined;
              resolve();
            };
            child.send("shown", () => {});
          }),
      });
    });
  });
}

/** Share the live runner's single refresh provider while it is alive. Tokens only
 * cross the private IPC channel, never argv, stdout, events or recovery journals.
 * After parent death a fresh file-backed provider can rotate credentials itself.
 */
export function watchdogAccessToken(
  independent: () => Promise<string>,
  channel: Pick<
    NodeJS.Process,
    "connected" | "on" | "removeListener" | "send"
  > = process,
): Promise<string> {
  if (!channel.connected) return independent();
  return new Promise((done, reject) => {
    let settled = false;
    const clean = () => {
      clearTimeout(timer);
      channel.removeListener("message", received);
      channel.removeListener("disconnect", disconnected);
    };
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clean();
      if (value) done(value);
      else reject(new Error("Title watchdog authorization refused"));
    };
    const received = (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      if (
        message.type === "title-token" &&
        "value" in message &&
        typeof message.value === "string"
      )
        finish(message.value);
      else if (message.type === "title-token-refused") finish();
    };
    const disconnected = () => {
      if (settled) return;
      settled = true;
      clean();
      void independent().then(done, reject);
    };
    const timer = setTimeout(() => finish(), 45_000);
    channel.on("message", received);
    channel.on("disconnect", disconnected);
    channel.send?.("token-request", (error: Error | null) => {
      if (error) {
        if (!channel.connected) disconnected();
        else finish();
      }
    });
  });
}

/** Lease-bound restoration never lets an older round overwrite a newer scorebug. */
export async function restoreWatchedTitle(options: {
  journalPath: string;
  lease: string;
  broadcasterId: string;
  helix: Pick<LiveHelix, "setChannelTitle">;
}): Promise<void> {
  let journal: unknown;
  try {
    const file = await lstat(options.journalPath);
    if (!file.isFile() || (file.mode & 0o077) !== 0)
      throw new Error("Unsafe title recovery journal");
    journal = JSON.parse(await readFile(options.journalPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !journal ||
    typeof journal !== "object" ||
    !("version" in journal) ||
    journal.version !== 1 ||
    !("broadcasterId" in journal) ||
    journal.broadcasterId !== options.broadcasterId ||
    !("lease" in journal) ||
    journal.lease !== options.lease
  )
    return;
  if (
    !("original" in journal) ||
    typeof journal.original !== "string" ||
    !journal.original ||
    [...journal.original].length > 140 ||
    !options.helix.setChannelTitle
  )
    throw new Error("Invalid title recovery journal");
  await options.helix.setChannelTitle(journal.original);
  // A new lease can replace the journal while a request is in flight. Keep that receipt.
  const latest: unknown = JSON.parse(
    await readFile(options.journalPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "null";
        throw error;
      },
    ),
  );
  if (
    latest &&
    typeof latest === "object" &&
    "lease" in latest &&
    latest.lease === options.lease
  )
    await rm(options.journalPath, { force: true });
}

/** IPC disconnection is the parent's death notification. No poller is involved. */
export function runTitleWatchdog(options: {
  restore(): Promise<void>;
  connected: boolean;
  on(
    event: "message" | "disconnect",
    listener: (message?: unknown) => void,
  ): void;
  ready(): void;
  shown?(): void;
  finish(failed: boolean, restored?: boolean): void;
  deadlineMs?: number;
}): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function restore() {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      await options.restore();
      options.finish(false, true);
    } catch {
      options.finish(true);
    }
  }
  options.on("message", (message) => {
    if (message === "shown" && !settled) {
      clearTimeout(timer);
      timer = setTimeout(() => void restore(), options.deadlineMs ?? 60_000);
      options.shown?.();
      return;
    }
    if (message === "restore") {
      void restore();
      return;
    }
    if (message !== "cancel" || settled) return;
    settled = true;
    clearTimeout(timer);
    options.finish(false);
  });
  options.on("disconnect", () => void restore());
  options.ready();
  if (!options.connected) void restore();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [journalPath, lease, broadcasterId] = process.argv.slice(2);
  if (!journalPath || !lease || !broadcasterId) process.exitCode = 1;
  else {
    runTitleWatchdog({
      connected: process.connected,
      on: (event, listener) => process.on(event, listener),
      ready: () => process.send?.("ready"),
      shown: () => process.send?.("shown"),
      finish: (failed, restored) => {
        process.exitCode = failed ? 1 : 0;
        if (process.connected)
          process.send?.(
            failed ? "failed" : restored ? "restored" : "canceled",
            () => {
              if (process.connected) process.disconnect();
            },
          );
      },
      restore: async () => {
        const stored = readToken();
        if (stored.userId !== broadcasterId)
          throw new Error("Title recovery account mismatch");
        const helix = createLiveHelix({
          clientId: stored.clientId,
          broadcasterId,
          senderId: broadcasterId,
          accessToken: () =>
            watchdogAccessToken(async () => {
              const latest = readToken();
              if (latest.userId !== broadcasterId)
                throw new Error("Title recovery account mismatch");
              const auth = createAuth(latest);
              const value = await auth.getAccessTokenForUser(broadcasterId, [
                ...SCOPES,
              ]);
              if (!value?.accessToken)
                throw new Error("Title recovery authorization unavailable");
              return value.accessToken;
            }),
        });
        await restoreWatchedTitle({ journalPath, lease, broadcasterId, helix });
      },
    });
  }
}
