import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SessionOperations, persistenceClock } from "../src/adapters/session/sessionOperation.js";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { nodeSessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import { PersistenceError, SessionAccessError, type SessionOperation, type TurnFact } from "../src/contracts/session.js";
import { PersistenceSupervisor } from "../src/bootstrap/persistenceSupervisor.js";
import { TestClock, deferred, flush } from "./persistenceHelpers.js";

const operations: SessionOperation[] = ["create", "open_write", "append", "close", "list"];
const user = (): TurnFact => ({ type: "user", turnId: randomUUID(), runtimeProfile: { provider: "test", model: "test" }, message: { role: "user", content: "问题" } });

describe("T7 固定30秒总等待与实际 settle", () => {
  it.each(operations)("%s 永不 settle：29999未超时、30000拒绝，禁止后继操作且不取消原 Promise", async (operation) => {
    const clock = new TestClock(); const waiter = new SessionOperations(clock); const gate = deferred();
    let done = false;
    const running = waiter.run(operation, () => gate.promise);
    const observed = running.catch((error: unknown) => error);
    void running.then(() => { done = true; }, () => { done = true; });
    clock.advance(29_999); await flush(); expect(done).toBe(false);
    clock.advance(1);
    const error = await observed;
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({ code: "io_timeout", operation });
    const next = vi.fn(async () => 1);
    await expect(waiter.run("append", next)).rejects.toBe(error);
    expect(next).not.toHaveBeenCalled();
    // 故意保持原 gate 未 settle；它没有操作系统句柄，不能被包装器当成已完成。
    expect(clock.timers.size).toBe(0);
  });

  it.each(["resolve", "reject"])("超时后迟到 %s 被观察，不复活公开结果或重试", async (kind) => {
    const clock = new TestClock(); const waiter = new SessionOperations(clock); const gate = deferred<number>();
    const observed = waiter.run("create", () => gate.promise).catch((error: unknown) => error);
    clock.advance(30_000); const error = await observed;
    clock.advance(10_000);
    if (kind === "resolve") gate.resolve(7); else gate.reject(new Error("晚到拒绝"));
    await flush();
    expect(await observed).toBe(error);
    expect(waiter.failure).toBe(error);
    expect(clock.timers.size).toBe(0);
    await expect(waiter.run("close", async () => {})).resolves.toBeUndefined();
  });

  it.each(["resolve", "reject"])("期限前 %s 原样交付并撤销定时器", async (kind) => {
    const clock = new TestClock(); const waiter = new SessionOperations(clock); const gate = deferred<number>();
    const result = waiter.run("open_write", () => gate.promise); const observed = result.catch((error: unknown) => error);
    const error = new Error("安全替身"); clock.advance(29_999);
    if (kind === "resolve") { gate.resolve(7); expect(await result).toBe(7); } else { gate.reject(error); expect(await observed).toBe(error); }
    expect(waiter.failure).toBeUndefined(); expect(clock.timers.size).toBe(0);
  });

  it("定时回调尚未调度但单调时钟已超限，不能确认迟到成功", async () => {
    const clock = new TestClock(); const waiter = new SessionOperations(clock); const gate = deferred<number>();
    const result = waiter.run("append", () => gate.promise).catch((error: unknown) => error);
    clock.time = 30_001; gate.resolve(1);
    expect(await result).toMatchObject({ code: "io_timeout" });
    expect(clock.timers.size).toBe(0);
  });

  it("默认期限计时器保持 Node 事件循环存活", () => {
    const original = globalThis.setTimeout;
    let hasRef = false;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
      const timer = original(...args); hasRef = timer.hasRef(); return timer;
    });
    try { const cancel = persistenceClock.schedule(30_000, () => {}); expect(hasRef).toBe(true); cancel(); }
    finally { spy.mockRestore(); }
  });
});

describe("T7 实际文件、锁和等待期限", () => {
  let directory: string; let root: string;
  const adapters: SessionFileAdapter[] = [];
  const releaseGates: (() => void)[] = [];
  /** 即使断言失败也能释放本测试创建的真实 I/O 门闩，避免 afterEach 持锁挂起。 */
  function ioGate() { const gate = deferred(); releaseGates.push(gate.resolve); return gate; }
  beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t7-timeout-"))); root = join(directory, ".yucli"); });
  afterEach(async () => { for (const release of releaseGates.splice(0)) release(); for (const adapter of adapters.splice(0)) await adapter.closeSettled(); await rm(directory, { recursive: true, force: true }); });

  it.each(["create", "open_write"])("%s 的取锁前最后一次 I/O 超时，迟到 settle 后也不取锁或创建锁文件", async (operation) => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate();
    const id = randomUUID(); const createdAt = "2026-10-29T12:00:00.000Z";
    const sessions = join(root, "sessions");
    const basename = `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${id}.jsonl`;
    const original = Buffer.from(JSON.stringify({ type: "session_meta", formatVersion: 1, sessionId: id, createdAt, cwd: directory }) + "\n");
    if (operation === "open_write") {
      // 离线构造正文 fixture，没有调用创建器，因此初始状态没有 locks 容器或 sidecar。
      await nodeSessionFileIO.mkdir(root); await nodeSessionFileIO.mkdir(sessions);
      await writeFile(join(sessions, basename), original, { mode: 0o600 });
    }
    const native = new SessionLockAdapter({ storageRoot: root });
    const acquire = vi.fn(native.acquire.bind(native)); const uuid = vi.fn(() => id);
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, uuid,
      locks: { preflight: () => native.preflight(), acquire },
      io: {
        lstat: async (path) => {
          const identity = await nodeSessionFileIO.lstat(path);
          if (operation === "create" && path === sessions) { entered.resolve(); await gate.promise; }
          return identity;
        },
        readdir: async (path) => {
          const names = await nodeSessionFileIO.readdir(path);
          if (operation === "open_write" && path === sessions) { entered.resolve(); await gate.promise; }
          return names;
        },
      },
    }); adapters.push(adapter);
    const observed = (operation === "create" ? adapter.create(directory) : adapter.openWrite({ sessionId: id, cwd: directory })).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000);
    const timeout = await observed; expect(timeout).toMatchObject({ code: "io_timeout", operation });
    expect(acquire).not.toHaveBeenCalled();
    let closed = false; const closing = adapter.closeSettled().then(() => { closed = true; });
    await flush(); expect(closed).toBe(false);
    gate.resolve(); await closing;
    expect(acquire).not.toHaveBeenCalled(); expect(uuid).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["sessions"]);
    expect(await readdir(sessions)).toEqual(operation === "create" ? [] : [basename]);
    if (operation === "open_write") expect(await readFile(join(sessions, basename))).toEqual(original);
    expect(await observed).toBe(timeout);
  });

  it.each(["busy", "identity-collision"])("create 的 %s 重试前超时，不再生成新身份或再次取锁", async (stage) => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate();
    const native = new SessionLockAdapter({ storageRoot: root }); const id = randomUUID();
    const uuid = vi.fn(() => id); const release = vi.fn();
    const acquire = vi.fn(async (sessionId: string) => {
      if (stage === "busy") {
        entered.resolve(); await gate.promise;
        throw new SessionAccessError("session_busy", "acquire", "测试身份已占用。");
      }
      const lock = await native.acquire(sessionId);
      const originalRelease = lock.release.bind(lock);
      // 模拟碰撞清理在超时后才 settle；既有锁必须正常释放，再停止下一轮取锁。
      lock.release = async () => { release(); entered.resolve(); await gate.promise; await originalRelease(); };
      return lock;
    });
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, uuid,
      locks: { preflight: () => native.preflight(), acquire },
      io: { readdir: async (path) => stage === "identity-collision" && path === join(root, "sessions")
        ? [`2026-10-29T12-00-00-000Z_${id}.jsonl`] : nodeSessionFileIO.readdir(path) },
    }); adapters.push(adapter);
    const observed = adapter.create(directory).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); const timeout = await observed;
    expect(timeout).toMatchObject({ code: "io_timeout", operation: "create" });
    gate.resolve(); await adapter.closeSettled();
    expect(acquire).toHaveBeenCalledOnce(); expect(uuid).toHaveBeenCalledOnce();
    expect(await readdir(join(root, "sessions"))).toEqual([]);
    if (stage === "identity-collision") { expect(release).toHaveBeenCalledOnce(); expect(await native.probe(id)).toBe("available"); }
    else expect(await readdir(root)).toEqual(["sessions"]);
    expect(await observed).toBe(timeout);
  });

  it.each(["write", "sync", "acquire"])("create 在 %s 超时后不交付 writer，真实 I/O settle 前持锁、不开始后继写入", async (stage) => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate();
    const native = new SessionLockAdapter({ storageRoot: root }); const acquire = native.acquire.bind(native);
    const id = randomUUID(); let hold = true;
    const pause = async () => { if (hold) { hold = false; entered.resolve(); await gate.promise; } };
    const writes = vi.fn(nodeSessionFileIO.write);
    const adapter = new SessionFileAdapter({ storageRoot: root, uuid: () => id, clock,
      locks: { preflight: () => native.preflight(), acquire: async (sessionId) => { const lock = await acquire(sessionId); if (stage === "acquire") await pause(); return lock; } },
      io: {
        write: async (...args) => { if (stage === "write") await pause(); return writes(...args); },
        sync: async (handle) => { if (stage === "sync") await pause(); await nodeSessionFileIO.sync(handle); },
      },
    }); adapters.push(adapter);
    const creation = adapter.create(directory).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); const error = await creation;
    expect(error).toMatchObject({ code: "io_timeout", operation: "create" });
    await expect(adapter.create(directory)).rejects.toBe(error);
    expect(await native.probe(id)).toBe("busy");
    let closed = false; const closing = adapter.closeSettled().then(() => { closed = true; });
    await flush(); expect(closed).toBe(false);
    gate.resolve(); await closing;
    expect(await native.probe(id)).toBe("available");
    expect(writes).toHaveBeenCalledTimes(stage === "acquire" ? 0 : 1);
  });

  it("openWrite 长扫描后同步超时，不交付 writer，迟到 settle 后才关正文释放锁", async () => {
    const first = new SessionFileAdapter({ storageRoot: root }); adapters.push(first);
    const created = await first.create(directory); await created.writer.close();
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate(); const close = vi.fn(nodeSessionFileIO.close);
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: { sync: async (handle) => { entered.resolve(); await gate.promise; await nodeSessionFileIO.sync(handle); }, close } });
    adapters.push(adapter); const native = new SessionLockAdapter({ storageRoot: root });
    const running = adapter.openWrite({ sessionId: created.snapshot.meta.sessionId, cwd: directory }).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000);
    expect(await running).toMatchObject({ code: "io_timeout", operation: "open_write" });
    const closing = adapter.closeSettled(); expect(close).not.toHaveBeenCalled();
    expect(await native.probe(created.snapshot.meta.sessionId)).toBe("busy");
    gate.resolve(); await closing;
    expect(await native.probe(created.snapshot.meta.sessionId)).toBe("available"); expect(close).toHaveBeenCalledOnce();
  });

  it.each(["short-write", "sync"])("append %s 超时，队列仍等待真实 I/O；后继事实拒绝且不确认迟到记录", async (stage) => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate(); let hold = false;
    const writes = vi.fn(nodeSessionFileIO.write);
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: {
      write: async (handle, bytes, position) => {
        if (hold && stage === "short-write") { entered.resolve(); await gate.promise; return writes(handle, bytes.subarray(0, 3), position); }
        return writes(handle, bytes, position);
      },
      sync: async (handle) => { if (hold && stage === "sync") { entered.resolve(); await gate.promise; } await nodeSessionFileIO.sync(handle); },
    } }); adapters.push(adapter);
    const opened = await adapter.create(directory); writes.mockClear(); hold = true;
    const running = opened.writer.appendDurable(user()).catch((error: unknown) => error);
    await entered.promise; clock.advance(20_000);
    const queued = opened.writer.appendDurable(user()).catch((error: unknown) => error);
    clock.advance(10_000); const error = await running;
    expect(error).toMatchObject({ code: "io_timeout", operation: "append" });
    await expect(opened.writer.appendDurable(user())).rejects.toBe(error);
    const native = new SessionLockAdapter({ storageRoot: root }); expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("busy");
    const closing = adapter.closeSettled(); gate.resolve(); await closing;
    expect(await queued).toBe(error); expect(writes).toHaveBeenCalledOnce();
    expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("available");
  });

  it("append 超时后底层 sync 迟到拒绝被观察，收尾仍关闭正文再释放锁", async () => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate(); let hold = false;
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: {
      sync: async (handle) => { if (hold) { entered.resolve(); await gate.promise; } await nodeSessionFileIO.sync(handle); },
    } }); adapters.push(adapter);
    const opened = await adapter.create(directory); hold = true;
    const observed = opened.writer.appendDurable(user()).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); const timeout = await observed;
    expect(timeout).toMatchObject({ code: "io_timeout" });
    const closing = adapter.closeSettled(); gate.reject(new Error("晚到原始 I/O 拒绝")); await closing;
    expect(await observed).toBe(timeout);
    const native = new SessionLockAdapter({ storageRoot: root }); expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("available");
  });

  it.each(["writer", "adapter"])("%s close 超时后重入同一公开结果，真实关闭在故障5秒内完成可正常返回5", async (owner) => {
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate(); let hold = false;
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: { close: async (handle) => { if (hold) { entered.resolve(); await gate.promise; } await nodeSessionFileIO.close(handle); } } });
    adapters.push(adapter); const opened = await adapter.create(directory); hold = true;
    const target = owner === "writer" ? opened.writer : adapter;
    const closing = target.close(); const observed = closing.catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); const error = await observed;
    expect(error).toMatchObject({ code: "io_timeout", operation: "close" }); expect(target.close()).toBe(closing);
    const native = new SessionLockAdapter({ storageRoot: root }); expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("busy");
    const exit = vi.fn(); const supervisor = new PersistenceSupervisor({ clock, stopInput: vi.fn(), cancel: vi.fn(), close: () => adapter.closeSettled(), exit, writeError: vi.fn() });
    const stopped = supervisor.fail(error as PersistenceError); clock.advance(4_999); gate.resolve(); expect(await stopped).toBe(5);
    expect(exit).not.toHaveBeenCalled(); expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("available");
  });

  it("append 永久挂起经过30秒+5秒应急退出，期间不提前关闭或解锁", async () => {
    const clock = new TestClock(); const gate = ioGate(); const entered = deferred(); let hold = false;
    const close = vi.fn(nodeSessionFileIO.close);
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: { write: async (...args) => { if (hold) { entered.resolve(); await gate.promise; } return nodeSessionFileIO.write(...args); }, close } });
    adapters.push(adapter); const opened = await adapter.create(directory); close.mockClear(); hold = true;
    const running = opened.writer.appendDurable(user()).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); const error = await running;
    const exit = vi.fn(); const supervisor = new PersistenceSupervisor({ clock, stopInput: vi.fn(), cancel: vi.fn(), close: () => adapter.closeSettled(), exit, writeError: vi.fn() });
    const stopping = supervisor.fail(error as PersistenceError); clock.advance(5_000);
    expect(await stopping).toBe(5); expect(exit).toHaveBeenCalledExactlyOnceWith(5); expect(close).not.toHaveBeenCalled();
    const native = new SessionLockAdapter({ storageRoot: root }); expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("busy");
    // 测试退出替身不结束进程，最后释放门闩以收回临时资源；生产退出由内核回收锁。
    gate.resolve(); await adapter.closeSettled();
  });

  it("修复备份写入超时保留产物，迟到后不再修改正文", async () => {
    const first = new SessionFileAdapter({ storageRoot: root }); adapters.push(first);
    const opened = await first.create(directory); await opened.writer.close();
    const basename = (await readdir(join(root, "sessions")))[0]!; const source = join(root, "sessions", basename);
    const original = (await readFile(source)).subarray(0, -1);
    const { writeFile } = await import("node:fs/promises"); await writeFile(source, original);
    const clock = new TestClock(); const entered = deferred(); const gate = ioGate(); const paths = new Map<FileHandle, string>();
    const truncate = vi.fn(nodeSessionFileIO.truncate);
    const adapter = new SessionFileAdapter({ storageRoot: root, clock, io: {
      open: async (path, flags, mode) => { const handle = await nodeSessionFileIO.open(path, flags, mode); paths.set(handle, path); return handle; },
      write: async (handle, bytes, position) => { if (paths.get(handle)?.endsWith(".bak")) { entered.resolve(); await gate.promise; } return nodeSessionFileIO.write(handle, bytes, position); }, truncate,
    } }); adapters.push(adapter);
    const result = adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: directory }).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); expect(await result).toMatchObject({ code: "io_timeout" });
    gate.resolve(); await adapter.closeSettled();
    expect(await readFile(source)).toEqual(original); expect(truncate).not.toHaveBeenCalled();
    expect((await readdir(join(root, "recovery", opened.snapshot.meta.sessionId))).some((name) => name.endsWith(".bak"))).toBe(true);
  });
});
