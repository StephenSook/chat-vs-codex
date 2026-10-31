import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFatalCleanup, TitleScorebug } from "../src/title-scorebug.js";
import {
  restoreWatchedTitle,
  runTitleWatchdog,
  watchdogAccessToken,
} from "../src/title-watchdog.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(overrides: { enabled?: boolean; dryChat?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "title-score-"));
  directories.push(directory);
  const journalPath = join(directory, "title.json");
  const helix = {
    isLive: vi.fn(async () => true),
    channelTitle: vi.fn(async () => "Original title: exact  spaces!"),
    setChannelTitle: vi.fn(async (_title: string) => {}),
    chat: vi.fn(async () => "id"),
    marker: vi.fn(async () => {}),
    clip: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
  };
  const record = vi.fn();
  const report = vi.fn();
  const cancel = vi.fn(async () => {});
  let watchdogWork = Promise.resolve();
  const armWatchdog = vi.fn(
    async (
      options: Parameters<
        typeof import("../src/title-watchdog.js").armTitleWatchdog
      >[0],
    ) => {
      let operation: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const restore = () => {
        clearTimeout(timer);
        operation ??= (async () => {
          try {
            await restoreWatchedTitle({ ...options, helix });
            options.onRestored?.();
          } catch (error) {
            options.onFailure?.();
            throw error;
          }
        })();
        return operation;
      };
      return {
        shown: async () => {
          timer = setTimeout(() => {
            watchdogWork = restore().catch(() => {});
          }, 60_000);
        },
        cancel: async () => {
          clearTimeout(timer);
          await cancel();
        },
        restore,
      };
    },
  );
  const scorebug = new TitleScorebug({
    enabled: true,
    broadcasterId: "channel",
    journalPath,
    helix,
    record,
    report,
    armWatchdog,
    ...overrides,
  });
  return {
    scorebug,
    journalPath,
    helix,
    record,
    report,
    armWatchdog,
    cancel,
    waitWatchdog: () => watchdogWork,
  };
}
describe("reversible opt-in live title", () => {
  it("does nothing by default, in dry-chat or offline", async () => {
    for (const flags of [{ enabled: false }, { dryChat: true }]) {
      const test = await setup(flags);
      await test.scorebug.recover();
      await test.scorebug.show({ chat: 1, codex: 2 });
      await test.scorebug.close();
      expect(test.helix.isLive).not.toHaveBeenCalled();
      expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
    }
    const test = await setup();
    test.helix.isLive.mockResolvedValue(false);
    await test.scorebug.show({ chat: 1, codex: 2 });
    await test.scorebug.close();
    expect(test.helix.channelTitle).not.toHaveBeenCalled();
    expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
  });
  it("writes a private journal and arms the independent watchdog before mutation, restoring after 60 seconds", async () => {
    vi.useFakeTimers();
    const test = await setup();
    test.helix.setChannelTitle.mockImplementation(async (title) => {
      if (!title.startsWith("[")) return;
      expect(test.armWatchdog).toHaveBeenCalledOnce();
      expect((await stat(test.journalPath)).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(await readFile(test.journalPath, "utf8")).original,
      ).toBe("Original title: exact  spaces!");
    });
    await test.scorebug.show({ chat: 2, codex: 4 });
    expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
      "[CHAT 2 : CODEX 4] Original title: exact  spaces!",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await test.scorebug.close();
    expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
      "Original title: exact  spaces!",
    );
    await expect(stat(test.journalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not write a title if the watchdog fails to arm", async () => {
    const test = await setup();
    test.armWatchdog.mockRejectedValue(new Error("fork refused"));
    await expect(test.scorebug.show({ chat: 0, codex: 1 })).rejects.toThrow(
      "fork refused",
    );
    expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
    await test.scorebug.close();
  });
  it("never stacks prefixes, cancels the old watchdog and timer, and restores on shutdown", async () => {
    vi.useFakeTimers();
    const test = await setup();
    await test.scorebug.show({ chat: 0, codex: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    await test.scorebug.show({ chat: 1, codex: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.helix.setChannelTitle).toHaveBeenCalledTimes(2);
    expect(test.cancel).toHaveBeenCalledOnce();
    expect(test.helix.channelTitle).toHaveBeenCalledOnce();
    expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
      "[CHAT 1 : CODEX 1] Original title: exact  spaces!",
    );
    await test.scorebug.close();
    expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
      "Original title: exact  spaces!",
    );
    await vi.advanceTimersByTimeAsync(90_000);
    expect(test.helix.setChannelTitle).toHaveBeenCalledTimes(3);
  });
  it("recovers an interrupted title before listening, even with the flag now off", async () => {
    const test = await setup({ enabled: false });
    await writeFile(
      test.journalPath,
      JSON.stringify({
        version: 1,
        lease: "old",
        broadcasterId: "channel",
        original: "Exact original",
      }),
      { mode: 0o600 },
    );
    await test.scorebug.recover();
    expect(test.helix.setChannelTitle).toHaveBeenCalledWith("Exact original");
    await test.scorebug.close();
    await expect(stat(test.journalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retains the journal, reports a restore refusal, and retries during shutdown", async () => {
    vi.useFakeTimers();
    const test = await setup();
    await test.scorebug.show({ chat: 0, codex: 1 });
    test.helix.setChannelTitle.mockRejectedValueOnce(
      new Error("network refused"),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await test.waitWatchdog();
    expect(test.report).toHaveBeenCalled();
    expect((await stat(test.journalPath)).mode & 0o777).toBe(0o600);
    await test.scorebug.close();
    await expect(stat(test.journalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rolls back an ambiguous set failure rather than assuming no mutation occurred", async () => {
    const test = await setup();
    test.helix.setChannelTitle.mockRejectedValueOnce(
      new Error("connection lost after write"),
    );
    await expect(test.scorebug.show({ chat: 0, codex: 1 })).rejects.toThrow(
      "connection lost",
    );
    expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
      "Original title: exact  spaces!",
    );
    await test.scorebug.close();
  });
  it("refuses unsafe journals and never truncates a 140-character original", async () => {
    const test = await setup();
    test.helix.channelTitle.mockResolvedValue("a".repeat(140));
    await test.scorebug.show({ chat: 1, codex: 2 });
    expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
    await writeFile(
      test.journalPath,
      JSON.stringify({
        version: 1,
        broadcasterId: "channel",
        original: "Original",
      }),
      { mode: 0o600 },
    );
    await chmod(test.journalPath, 0o644);
    await expect(test.scorebug.recover()).rejects.toThrow("0600");
    await test.scorebug.close();
  });
});

it("fatal process errors trigger normal cleanup and remove their listeners", () => {
  const emitter = new EventEmitter();
  const abort = vi.fn();
  const report = vi.fn();
  const remove = installFatalCleanup(abort, report, emitter as never);
  emitter.emit("uncaughtException", new Error("private details"));
  emitter.emit("unhandledRejection", new Error("private details"));
  expect(abort).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(2);
  remove();
  expect(emitter.listenerCount("uncaughtException")).toBe(0);
  expect(emitter.listenerCount("unhandledRejection")).toBe(0);
});
it("the finite watchdog restores on parent IPC disconnect without waiting for the deadline", async () => {
  vi.useFakeTimers();
  const emitter = new EventEmitter();
  const restore = vi.fn(async () => {});
  const finish = vi.fn();
  runTitleWatchdog({
    restore,
    connected: true,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    ready: vi.fn(),
    finish,
  });
  emitter.emit("disconnect");
  await Promise.resolve();
  expect(restore).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith(false, true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(restore).toHaveBeenCalledOnce();
});
it("the watchdog has a bounded deadline and records failure rather than clearing recovery evidence", async () => {
  vi.useFakeTimers();
  const emitter = new EventEmitter();
  const restore = vi.fn(async () => {
    throw new Error("refused");
  });
  const finish = vi.fn();
  runTitleWatchdog({
    restore,
    connected: true,
    on: (event, listener) => {
      emitter.on(event, listener);
    },
    ready: vi.fn(),
    finish,
  });
  emitter.emit("message", "shown");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(restore).toHaveBeenCalledOnce();
  expect(finish).toHaveBeenCalledWith(true);
});
it("a stale watchdog cannot touch a newer lease or another broadcaster", async () => {
  const test = await setup();
  await writeFile(
    test.journalPath,
    JSON.stringify({
      version: 1,
      lease: "new",
      broadcasterId: "channel",
      original: "Exact",
    }),
    { mode: 0o600 },
  );
  await restoreWatchedTitle({
    journalPath: test.journalPath,
    lease: "old",
    broadcasterId: "channel",
    helix: test.helix,
  });
  await restoreWatchedTitle({
    journalPath: test.journalPath,
    lease: "new",
    broadcasterId: "other",
    helix: test.helix,
  });
  expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
  await test.scorebug.close();
});

it("a real detached watchdog restores using a fake adapter after its parent process exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "title-parent-exit-"));
  directories.push(directory);
  const journalPath = join(directory, "journal.json");
  const receiptPath = join(directory, "restored.json");
  await writeFile(
    journalPath,
    JSON.stringify({
      version: 1,
      lease: "fixture",
      broadcasterId: "channel",
      original: "Exact original:  two spaces",
    }),
    { mode: 0o600 },
  );
  const watchdogModule = new URL("../src/title-watchdog.ts", import.meta.url)
    .href;
  const childPath = join(directory, "watchdog.mjs");
  await writeFile(
    childPath,
    `import { writeFile } from 'node:fs/promises';
import { runTitleWatchdog, restoreWatchedTitle } from ${JSON.stringify(watchdogModule)};
runTitleWatchdog({ connected: process.connected, on: (event, listener) => process.on(event, listener), ready: () => process.send('ready'), finish: (failed) => { if(process.connected) process.disconnect(); process.exitCode = failed ? 1 : 0; }, restore: () => restoreWatchedTitle({ journalPath: ${JSON.stringify(journalPath)}, lease: 'fixture', broadcasterId: 'channel', helix: { setChannelTitle: async (title) => { await writeFile(${JSON.stringify(receiptPath)}, JSON.stringify({title}), { mode: 0o600 }); process.stdout.write(JSON.stringify({title})); } } }) });`,
  );
  const parentPath = join(directory, "parent.mjs");
  await writeFile(
    parentPath,
    `import { fork } from 'node:child_process';
const child = fork(${JSON.stringify(childPath)}, [], { execArgv: ['--import', 'tsx'], detached: true, stdio: ['ignore',4,'ignore','ipc'] });
child.on('message', (message) => { if(message === 'ready') { child.unref(); child.channel.unref(); process.exit(0); } });
child.once('error', () => process.exit(1)); child.once('exit', (code) => { if(code !== 0) process.exit(1); });
`,
  );
  const parent = fork(parentPath, [], {
    execArgv: [],
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
  });
  const restored = new Promise<void>((done, reject) => {
    const pipe = parent.stdio[4];
    if (!pipe) {
      reject(new Error("Missing fixture pipe"));
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error("Detached title watchdog did not restore")),
      8_000,
    );
    pipe.once("data", () => {
      clearTimeout(timeout);
      done();
    });
    pipe.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const parentExited = new Promise<void>((done, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code) =>
      code === 0 ? done() : reject(new Error("Fixture parent failed")),
    );
  });
  await Promise.all([parentExited, restored]);
  expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual({
    title: "Exact original:  two spaces",
  });
});

it("watchdog shares the parent's refresh provider and refreshes independently only after parent death", async () => {
  const independent = vi.fn(async () => "after-parent-death");
  const emitter = new EventEmitter();
  const channel = Object.assign(emitter, { connected: true, send: vi.fn() });
  const pending = watchdogAccessToken(independent, channel as never);
  emitter.emit("message", { type: "title-token", value: "private-ipc-token" });
  await expect(pending).resolves.toBe("private-ipc-token");
  expect(independent).not.toHaveBeenCalled();
  const afterDeath = watchdogAccessToken(independent, channel as never);
  channel.connected = false;
  emitter.emit("disconnect");
  await expect(afterDeath).resolves.toBe("after-parent-death");
  expect(independent).toHaveBeenCalledOnce();
  expect(emitter.listenerCount("message")).toBe(0);
});
it("dry-chat cannot restore a pending journal, including through close cleanup", async () => {
  const test = await setup({ dryChat: true });
  await writeFile(
    test.journalPath,
    JSON.stringify({
      version: 1,
      lease: "old",
      broadcasterId: "channel",
      original: "Exact",
    }),
    { mode: 0o600 },
  );
  await expect(test.scorebug.recover()).rejects.toThrow("dry-chat");
  await test.scorebug.close();
  expect(test.helix.setChannelTitle).not.toHaveBeenCalled();
});

it("starts the full 60 seconds only after a slow title PATCH completes", async () => {
  vi.useFakeTimers();
  const test = await setup();
  let completePatch: (() => void) | undefined;
  test.helix.setChannelTitle.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        completePatch = done;
      }),
  );
  const displayed = test.scorebug.show({ chat: 1, codex: 2 });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(test.helix.setChannelTitle).toHaveBeenCalledOnce();
  expect(completePatch).toBeDefined();
  completePatch?.();
  await displayed;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(test.helix.setChannelTitle).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await test.waitWatchdog();
  expect(test.helix.setChannelTitle).toHaveBeenLastCalledWith(
    "Original title: exact  spaces!",
  );
  await test.scorebug.close();
});
