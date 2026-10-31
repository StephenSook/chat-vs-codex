import { randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { privateJson } from "../../twitch/src/auth.js";
import type { LiveHelix } from "../../twitch/src/helix.js";
import { armTitleWatchdog, type TitleWatchdog } from "./title-watchdog.js";

interface TitleJournal {
  version: 1;
  broadcasterId: string;
  lease: string;
  original: string;
}

/** The journal is written before the remote mutation and retained until restore succeeds.
 * A detached watchdog restores after runner death. Power loss leaves a journal
 * for recovery before the next startup listens.
 * Network/API failures remain visible and retain the journal for another recovery attempt.
 */
export class TitleScorebug {
  private pending = Promise.resolve();
  private original: string | undefined;
  private generation = 0;
  private closed = false;
  private watchdog: TitleWatchdog | undefined;
  private readonly resolvedRounds = new Set<string>();
  constructor(
    private readonly options: {
      enabled?: boolean;
      armWatchdog?: typeof armTitleWatchdog;
      dryChat?: boolean;
      broadcasterId: string;
      journalPath: string;
      helix: LiveHelix;
      accessToken?(): Promise<string>;
      fallbackRestore?(title: string): Promise<void>;
      record(event: Record<string, unknown>): void;
      report(message: string): void;
    },
  ) {}

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    // Keep the queue usable for a shutdown restore after an earlier API refusal.
    this.pending = next.catch(() => {});
    return next;
  }

  /** Recovery runs even when the opt-in flag is now off. */
  recover(): Promise<void> {
    return this.enqueue(async () => {
      let contents: string;
      try {
        const file = await lstat(this.options.journalPath);
        if (!file.isFile() || (file.mode & 0o077) !== 0)
          throw new Error("Title recovery journal must be a regular 0600 file");
        contents = await readFile(this.options.journalPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const journal: unknown = JSON.parse(contents);
      if (
        !journal ||
        typeof journal !== "object" ||
        !("version" in journal) ||
        journal.version !== 1 ||
        !("broadcasterId" in journal) ||
        journal.broadcasterId !== this.options.broadcasterId ||
        !("original" in journal) ||
        typeof journal.original !== "string" ||
        !journal.original ||
        [...journal.original].length > 140
      )
        throw new Error(
          "Invalid title recovery journal; restore manually before restarting",
        );
      // Dry-chat must never perform a remote mutation, including recovery.
      if (this.options.dryChat)
        throw new Error(
          "Pending title restoration requires a normal run; dry-chat cannot restore it",
        );
      this.original = journal.original;
      await this.restore("startup");
    });
  }

  resolved(
    roundId: string,
    score: { chat: number; codex: number },
  ): Promise<void> {
    if (this.resolvedRounds.has(roundId)) return Promise.resolve();
    this.resolvedRounds.add(roundId);
    return this.show(score);
  }

  show(score: { chat: number; codex: number }): Promise<void> {
    if (!this.options.enabled || this.options.dryChat || this.closed)
      return Promise.resolve();
    if (
      ![score.chat, score.codex].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      return Promise.reject(new Error("Invalid title score"));
    const generation = ++this.generation;
    return this.enqueue(async () => {
      if (this.closed || generation !== this.generation) return;
      if (!(await this.options.helix.isLive())) {
        this.options.record({
          type: "twitch.title-skipped",
          reason: "offline",
        });
        return;
      }
      const title =
        this.original ?? (await this.options.helix.channelTitle?.());
      if (!title || !this.options.helix.setChannelTitle)
        throw new Error("Reversible Twitch title adapter unavailable");
      const displayed = `[CHAT ${score.chat} : CODEX ${score.codex}] ${title}`;
      if ([...displayed].length > 140) {
        this.options.record({
          type: "twitch.title-skipped",
          reason: "title-length",
        });
        return;
      }
      const lease = randomUUID();
      // Arm the successor first; parent death before journal replacement leaves
      // the previous watchdog responsible for the previous lease.
      const watchdog = await (this.options.armWatchdog ?? armTitleWatchdog)({
        journalPath: this.options.journalPath,
        lease,
        broadcasterId: this.options.broadcasterId,
        ...(this.options.accessToken
          ? { accessToken: this.options.accessToken }
          : {}),
        onRestored: () => {
          if (generation !== this.generation) return;
          this.original = undefined;
          this.watchdog = undefined;
          this.options.record({
            type: "twitch.title-restored",
            reason: "watchdog",
          });
        },
        onFailure: () => {
          if (generation === this.generation) this.refusal("watchdog");
        },
      });
      const previousWatchdog = this.watchdog;
      const journal: TitleJournal = {
        version: 1,
        broadcasterId: this.options.broadcasterId,
        lease,
        original: title,
      };
      try {
        privateJson(this.options.journalPath, journal);
      } catch (error) {
        await watchdog.cancel();
        throw error;
      }
      this.watchdog = watchdog;
      await previousWatchdog?.cancel();
      this.original = title;
      try {
        await this.options.helix.setChannelTitle(displayed);
        await watchdog.shown();
        this.options.record({
          type: "twitch.title-set",
          ...score,
          restoreAfterMs: 60_000,
        });
      } catch (error) {
        this.refusal("set");
        // A transport error can follow a successful mutation. Attempt rollback now.
        await this.restore("set-failed");
        throw error;
      }
    });
  }

  private refusal(operation: string): void {
    this.options.record({ type: "twitch.title-refused", operation });
    this.options.report(
      `Twitch title ${operation} failed; original title retained in the private recovery journal. Restore the original title before ending the stream if recovery keeps failing.`,
    );
  }

  private async restore(reason: string): Promise<void> {
    if (this.original === undefined) return;
    try {
      if (!this.options.helix.setChannelTitle)
        throw new Error("Twitch title restoration adapter unavailable");
      const title = this.original;
      const watchdog = this.watchdog;
      if (watchdog) {
        try {
          await watchdog.restore();
        } catch {
          // The watchdog has exited before this path can use another provider.
          if (this.options.fallbackRestore)
            await this.options.fallbackRestore(title);
          else await this.options.helix.setChannelTitle(title);
        }
      } else await this.options.helix.setChannelTitle(title);
      await rm(this.options.journalPath, { force: true });
      this.watchdog = undefined;
      this.original = undefined;
      this.options.record({ type: "twitch.title-restored", reason });
    } catch (error) {
      this.refusal("restore");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    ++this.generation;
    await this.enqueue(() => this.restore("shutdown"));
  }
}

/** Fatal process errors share the normal asynchronous resource cleanup path. */
export function installFatalCleanup(
  abort: () => void,
  report: () => void,
  emitter: Pick<NodeJS.Process, "on" | "removeListener"> = process,
): () => void {
  const failed = () => {
    report();
    abort();
  };
  emitter.on("uncaughtException", failed);
  emitter.on("unhandledRejection", failed);
  return () => {
    emitter.removeListener("uncaughtException", failed);
    emitter.removeListener("unhandledRejection", failed);
  };
}
