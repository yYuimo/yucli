import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import type { SessionFileOptions } from "../src/adapters/session/SessionFileAdapter.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { nodeSessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import type { SessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import { scanSessionFile, scanSessionHandle } from "../src/adapters/session/scanSession.js";
import type { ScanResult, ValidScanResult } from "../src/adapters/session/scanTypes.js";
import { PersistenceError, SessionAccessError } from "../src/contracts/session.js";
import type { OpenedSession, ToolEnd, TurnFact } from "../src/contracts/session.js";
import type { SessionLock } from "../src/contracts/session-lock.js";

const createdAt = "2026-10-29T12:00:00.000Z";
const profile = { provider: "opencode-go", model: "deepseek-v4-flash" };
const toolFailure: ToolEnd = { outcome: "failed", error: { category: "tool", code: "tool_execution_failed", message: "工具执行失败。" } };
const turnId = "turn-a";
let directory: string;
let root: string;
const adapters: SessionFileAdapter[] = [];
const handles = new Set<FileHandle>();
const locks: { lock: SessionLock; release: () => Promise<void> }[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t4-writer-")));
  root = join(directory, ".yucli");
});

afterEach(async () => {
  // 故障用例会有意让 adapter 保留锁。测试最终用原始真实句柄清理，不改变生产的保守语义。
  for (const adapter of adapters.splice(0)) await adapter.close().catch(() => {});
  for (const handle of handles) await handle.close().catch(() => {});
  handles.clear();
  for (const held of locks.splice(0)) await held.release();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function user(id = turnId): TurnFact {
  return { type: "user", turnId: id, message: { role: "user", content: "读取中文😀\n下一行" }, runtimeProfile: { ...profile } };
}
function assistant(assistantId = "a1", withCall = false, id = turnId): TurnFact {
  return { type: "assistant", turnId: id, assistantId, message: withCall
    ? { role: "assistant", toolCalls: [{ id: "reused", name: "read_file", argumentsJson: '{"path":"a.md"}' }] }
    : { role: "assistant", content: "完整回答。" } };
}
function tool(type: "tool_start" | "tool_result" | "tool_end", assistantId = "a1", id = turnId): TurnFact {
  const base = { turnId: id, call: { assistantId, toolCallId: "reused", name: "read_file" } };
  if (type === "tool_result") return { ...base, type, result: { toolCallId: "reused", name: "read_file", ok: false, content: "" } };
  if (type === "tool_end") return { ...base, type, end: toolFailure };
  return { ...base, type };
}
function end(id = turnId): TurnFact { return { type: "turn_end", turnId: id, end: { outcome: "success" } }; }
function filename(id: string, time = createdAt) { return `${time.replaceAll(":", "-").replaceAll(".", "-")}_${id}.jsonl`; }
function source(opened: OpenedSession) { return join(root, "sessions", filename(opened.snapshot.meta.sessionId, opened.snapshot.meta.createdAt)); }
function valid(result: ScanResult): ValidScanResult {
  expect(result.status, result.status === "rejected" ? JSON.stringify(result.diagnostic) : "").toBe("valid");
  if (result.status !== "valid") throw new Error("expected valid scan");
  return result;
}
async function scan(opened: OpenedSession) { return valid(await scanSessionFile(source(opened), { chunkSizeBytes: 3 })); }

function setup(overrides: Partial<SessionFileIO> = {}, options: Omit<SessionFileOptions, "io" | "storageRoot"> = {}) {
  const paths = new Map<FileHandle, string>();
  const events: string[] = [];
  const nativeLocks = new SessionLockAdapter({ storageRoot: root });
  const acquire = nativeLocks.acquire.bind(nativeLocks);
  vi.spyOn(nativeLocks, "acquire").mockImplementation(async (id) => {
    const lock = await acquire(id);
    const release = lock.release.bind(lock);
    locks.push({ lock, release });
    vi.spyOn(lock, "release").mockImplementation(async () => { events.push("release"); await release(); });
    return lock;
  });
  const io: SessionFileIO = {
    ...nodeSessionFileIO,
    ...overrides,
    open: async (path, flags, mode) => {
      events.push(`open:${path}`);
      const handle = await (overrides.open ?? nodeSessionFileIO.open)(path, flags, mode);
      handles.add(handle);
      paths.set(handle, path);
      return handle;
    },
    sync: async (handle) => {
      events.push(`sync:${paths.get(handle)}`);
      await (overrides.sync ?? nodeSessionFileIO.sync)(handle);
    },
    close: async (handle) => {
      events.push(`close:${paths.get(handle)}`);
      await (overrides.close ?? nodeSessionFileIO.close)(handle);
    },
  };
  const adapter = new SessionFileAdapter({ storageRoot: root, io, locks: nativeLocks, now: () => new Date(createdAt), ...options });
  adapters.push(adapter);
  return { adapter, io, paths, events, nativeLocks, body: () => [...paths].find(([, path]) => path.endsWith(".jsonl"))![0] };
}

async function seed(id: string, time = createdAt) {
  await mkdir(root, { mode: 0o700 }).catch(() => {});
  await mkdir(join(root, "sessions"), { mode: 0o700 }).catch(() => {});
  const path = join(root, "sessions", filename(id, time));
  await writeFile(path, "existing private bytes", { mode: 0o600 });
  return path;
}

describe("T4 创建、身份与权限", () => {
  it("构造无 I/O；header/文件和各必要目录同步后才交付空快照，所有路径在临时目录", async () => {
    const harness = setup();
    expect(await readdir(directory)).toEqual([]);
    const opened = await harness.adapter.create(directory);
    expect(opened.snapshot).toEqual({ meta: { sessionId: expect.any(String), createdAt, cwd: directory }, recentSuccessfulTurns: [], interruptedTurnCount: 0, repair: "none" });
    expect(opened.snapshot.meta.sessionId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    const path = source(opened);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    for (const path of [root, join(root, "sessions"), join(root, "locks")]) expect((await lstat(path)).mode & 0o777).toBe(0o700);
    expect(harness.events.filter((event) => event.startsWith("sync:"))).toEqual(
      [path, join(root, "sessions"), join(root, "locks"), root, dirname(root)].map((path) => `sync:${path}`),
    );
    for (const path of harness.paths.values()) expect(path === directory || path.startsWith(`${directory}/`)).toBe(true);
    expect(await scan(opened)).toMatchObject({ lastSeq: 0, logState: "empty", tailKind: "none" });
    expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("busy");
    await opened.writer.close();
    expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("available");
    expect((await lstat(join(root, "locks", `${opened.snapshot.meta.sessionId}.lock`))).isFile()).toBe(true);
  });

  it("未支持平台预检在任何 mkdir/UUID 之前拒绝", async () => {
    const uuid = vi.fn(randomUUID);
    const native = new SessionLockAdapter({ storageRoot: root, runtime: { platform: "linux", arch: "arm64", node: "24.14.0" } });
    const harness = setup({}, { locks: native, uuid });
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: "platform_unsupported" });
    expect(uuid).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("cwd 必须为真实规范目录，符号链接入口/相对目录拒绝且不创建存储", async () => {
    const alias = join(directory, "alias");
    const file = join(directory, "file");
    await symlink(directory, alias);
    await writeFile(file, "not a directory");
    const { adapter } = setup();
    for (const cwd of [alias, file, ".", join(directory, "missing")]) await expect(adapter.create(cwd)).rejects.toBeInstanceOf(SessionAccessError);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["root-link", "sessions-link", "root-file", "sessions-file", "root-mode", "sessions-mode", "root-owner", "sessions-owner"])("拒绝受管目录边界 %s，不 chmod/跟随/覆盖", async (kind) => {
    const target = join(directory, "outside");
    await mkdir(target, { mode: 0o700 });
    const managed = kind.startsWith("root") ? root : join(root, "sessions");
    if (managed !== root) await mkdir(root, { mode: 0o700 });
    if (kind.endsWith("link")) await symlink(target, managed);
    else if (kind.endsWith("file")) await writeFile(managed, "unchanged", { mode: 0o600 });
    else { await mkdir(managed, { mode: 0o700 }); if (kind.endsWith("mode")) await chmod(managed, 0o755); }
    const harness = setup(kind.endsWith("owner") ? { lstat: async (path) => {
      const info = await nodeSessionFileIO.lstat(path);
      return path === managed ? Object.create(info, { uid: { value: info.uid + 1n } }) as BigIntStats : info;
    } } : {});
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: "permission_denied" });
    expect(await readdir(target)).toEqual([]);
    if (kind.endsWith("mode")) expect((await lstat(managed)).mode & 0o777).toBe(0o755);
    if (kind.endsWith("file")) expect(await readFile(managed, "utf8")).toBe("unchanged");
  });

  it("同毫秒创建两个 UUID 文件；快照修改不能改变 writer 身份", async () => {
    const { adapter } = setup();
    const a = await adapter.create(directory);
    const b = await adapter.create(directory);
    const originalId = a.snapshot.meta.sessionId;
    expect(b.snapshot.meta.sessionId).not.toBe(originalId);
    a.snapshot.meta.sessionId = b.snapshot.meta.sessionId;
    await a.writer.appendDurable(user());
    const path = join(root, "sessions", filename(originalId));
    expect(valid(await scanSessionFile(path)).meta.sessionId).toBe(originalId);
    expect(await readdir(join(root, "sessions"))).toHaveLength(2);
  });

  it("同 ID 多正文均不覆盖，重新生成身份且最多三次", async () => {
    const id = randomUUID();
    const a = await seed(id);
    const b = await seed(id, "2026-10-29T11:00:00.000Z");
    const before = await lstat(a);
    const uuid = vi.fn(() => id);
    const { adapter } = setup({}, { uuid });
    await expect(adapter.create(directory)).rejects.toMatchObject({ code: "invalid_identity" });
    expect(uuid).toHaveBeenCalledTimes(3);
    expect(await readFile(a, "utf8")).toBe("existing private bytes");
    expect(await readFile(b, "utf8")).toBe("existing private bytes");
    expect((await lstat(a)).ino).toBe(before.ino);
  });

  it.each(["file", "symlink"])("wx 与 readdir 之间出现 %s 仍不覆盖/跟随，换新 UUID", async (kind) => {
    const id = randomUUID();
    const next = randomUUID();
    const target = join(directory, "untouched");
    await writeFile(target, "target", { mode: 0o600 });
    const uuid = vi.fn().mockReturnValueOnce(id).mockReturnValue(next);
    let attempted = false;
    const harness = setup({ open: async (path, flags, mode) => {
      if (path.endsWith(filename(id)) && !attempted) {
        attempted = true;
        expect(flags & constants.O_EXCL).toBeTruthy();
        expect(flags & constants.O_NOFOLLOW).toBeTruthy();
        if (kind === "symlink") await symlink(target, path);
        else await writeFile(path, "race winner", { mode: 0o600 });
      }
      return nodeSessionFileIO.open(path, flags, mode);
    } }, { uuid });
    const opened = await harness.adapter.create(directory);
    expect(opened.snapshot.meta.sessionId).toBe(next);
    expect(uuid).toHaveBeenCalledTimes(2);
    expect(await readFile(target, "utf8")).toBe("target");
    expect(await readFile(join(root, "sessions", filename(id)), "utf8")).toBe(kind === "symlink" ? "target" : "race winner");
    expect(await scan(opened)).toMatchObject({ lastSeq: 0 });
  });

  it.each(["../escape", "not-a-uuid", "00000000-0000-1000-8000-000000000000"])("新身份不是 UUID v4 时拒绝 %s，不取锁", async (id) => {
    const harness = setup({}, { uuid: () => id });
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: "invalid_identity" });
    expect(harness.nativeLocks.acquire).not.toHaveBeenCalled();
    expect(await readdir(join(root, "sessions"))).toEqual([]);
  });

  it("普通创建 I/O 失败不重新生成 UUID，错误内容脱敏", async () => {
    const uuid = vi.fn(randomUUID);
    const { adapter } = setup({ open: async () => { throw new Error("RAW SECRET"); } }, { uuid });
    const error = await adapter.create(directory).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SessionAccessError);
    expect(error).toMatchObject({ operation: "create_open" });
    expect(String(error)).not.toContain("RAW SECRET");
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(locks[0]!.lock.release).toHaveBeenCalledOnce();
  });

  it.each(["mode", "hardlink", "replacement"])("wx 打开后 %s 边界在首字节前复核，失败不写 header", async (kind) => {
    const write = vi.fn(nodeSessionFileIO.write);
    const harness = setup({ write, open: async (path, flags, mode) => {
      const handle = await nodeSessionFileIO.open(path, flags, mode);
      if (path.endsWith(".jsonl")) {
        if (kind === "mode") await chmod(path, 0o644);
        if (kind === "hardlink") await link(path, `${path}.alias`);
        if (kind === "replacement") { await rename(path, `${path}.old`); await writeFile(path, "replacement", { mode: 0o600 }); }
      }
      return handle;
    } });
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: kind === "replacement" ? "ownership_lost" : "permission_denied" });
    expect(write).not.toHaveBeenCalled();
    expect(locks.at(-1)!.lock.release).toHaveBeenCalledOnce();
  });
});

describe("T4 事实转换与 T3 扫描 oracle", () => {
  it("两批复用 toolCallId、空/ok:false 结果和最终回答均通过双入口扫描，seq 连续", async () => {
    const harness = setup();
    const opened = await harness.adapter.create(directory);
    const facts = [user(), assistant("a1", true), tool("tool_start"), tool("tool_result"),
      assistant("a2", true), tool("tool_start", "a2"), tool("tool_result", "a2"), assistant("a3"), end()];
    for (const [index, fact] of facts.entries()) expect(await opened.writer.appendDurable(fact)).toEqual({ confirmedSeq: index + 1 });
    const result = await scan(opened);
    expect(result).toMatchObject({ lastSeq: 9, logState: "complete", tailKind: "none", statistics: { turnCount: 1, lastTurnOutcome: "success" } });
    expect(result.turns[0]!.calls).toMatchObject([{ callMessageSeq: 2, toolCallId: "reused", state: "result", ok: false }, { callMessageSeq: 5, toolCallId: "reused", state: "result", ok: false }]);
    const borrowed = await open(source(opened), "r");
    try { expect(await scanSessionHandle(borrowed, basename(source(opened)))).toEqual(result); }
    finally { await borrowed.close(); }
    const bytes = await readFile(source(opened));
    expect(bytes.at(-1)).toBe(0x0a);
    expect(bytes.toString()).not.toContain("assistantId");
    const records = bytes.toString().trim().split("\n").map((line) => JSON.parse(line) as { seq?: number });
    expect(records.slice(1).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("tool_end 只保留异常事实，turn_end 后新 turn 可复用 a1，跨 turn 映射不串配", async () => {
    const opened = await setup().adapter.create(directory);
    for (const fact of [user(), assistant("a1", true), tool("tool_start"), tool("tool_end"),
      { type: "turn_end", turnId, end: toolFailure } satisfies TurnFact,
      user("turn-b"), assistant("a1", true, "turn-b"), tool("tool_start", "a1", "turn-b"), tool("tool_result", "a1", "turn-b"), assistant("a2", false, "turn-b"), end("turn-b")]) {
      await opened.writer.appendDurable(fact);
    }
    const result = await scan(opened);
    expect(result.statistics).toMatchObject({ turnCount: 2, lastTurnOutcome: "success" });
    expect(result.turns[0]!.calls[0]).toMatchObject({ callMessageSeq: 2, state: "ended" });
    expect(result.turns[1]!.calls[0]).toMatchObject({ callMessageSeq: 7, state: "result" });
    expect(result.recentSuccessfulTurns.map((turn) => turn.turnId)).toEqual(["turn-b"]);
  });

  it("入口快照隔离排队期间的嵌套修改；I/O 串行且 assistant sync 后才允许工具引用", async () => {
    const entered = deferred();
    const release = deferred();
    let hold = false;
    const harness = setup({ sync: async (handle) => {
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      await nodeSessionFileIO.sync(handle);
    } });
    const opened = await harness.adapter.create(directory);
    await opened.writer.appendDurable(user());
    hold = true;
    const a = assistant("a1", true);
    const first = opened.writer.appendDurable(a);
    await entered.promise;
    const start = tool("tool_start");
    const second = opened.writer.appendDurable(start);
    if (a.type === "assistant") a.message.toolCalls![0]!.name = "changed";
    if (start.type === "tool_start") { start.call.assistantId = "changed"; start.call.name = "changed"; }
    try {
      expect((await readFile(source(opened), "utf8")).split("\n")).toHaveLength(4); // header + user + 未确认 assistant
      expect((await scan(opened)).lastSeq).toBe(2); // 读到一行不等于 append 已确认
    } finally { release.resolve(); }
    expect(await first).toEqual({ confirmedSeq: 2 });
    expect(await second).toEqual({ confirmedSeq: 3 });
    expect((await scan(opened)).turns[0]!.calls[0]).toMatchObject({ name: "read_file", callMessageSeq: 2, state: "unknown" });
  });

  const invalidCases: [string, (facts: TurnFact[]) => TurnFact][] = [
    ["重复 assistantId", () => assistant("a1", true)],
    ["未知 assistantId", () => tool("tool_start", "missing")],
    ["跨 turn 引用", () => tool("tool_start", "a1", "other")],
    ["结果没有 start", () => tool("tool_result")],
    ["success 缺最终回答和结果", () => end()],
    ["名称错配", () => ({ ...tool("tool_start"), call: { assistantId: "a1", toolCallId: "reused", name: "wrong" } }) as unknown as TurnFact],
    ["结果 ID 错配", () => ({ ...tool("tool_result"), result: { toolCallId: "wrong", name: "read_file", ok: true, content: "" } }) as unknown as TurnFact],
    ["工具结果覆盖磁盘引用", () => ({ ...tool("tool_result"), result: { toolCallId: "reused", name: "read_file", ok: true, content: "", callMessageSeq: 2 } }) as unknown as TurnFact],
    ["工具 end 覆盖磁盘引用", () => ({ ...tool("tool_end"), end: { ...toolFailure, callMessageSeq: 999 } }) as unknown as TurnFact],
    ["工具 end 使用模型错误", () => ({ ...tool("tool_end"), end: { outcome: "failed", error: { category: "model", code: "network", message: "失败" } } }) as unknown as TurnFact],
    ["新 user 缺 profile", () => ({ type: "user", turnId: "new", message: { role: "user", content: "新问题" } }) as unknown as TurnFact],
    ["事实多字段", () => ({ ...tool("tool_start"), seq: 100 }) as unknown as TurnFact],
    ["消息角色不匹配", () => ({ ...assistant(), message: { role: "user", content: "伪装" } }) as unknown as TurnFact],
    ["不可克隆对象", () => ({ ...tool("tool_start"), secret: () => {} }) as unknown as TurnFact],
  ];
  it.each(invalidCases)("写前拒绝 %s，保持原字节且永久故障", async (_label, makeInvalid) => {
    const opened = await setup().adapter.create(directory);
    const prefix = [user(), assistant("a1", true)];
    for (const fact of prefix) await opened.writer.appendDurable(fact);
    const before = await readFile(source(opened));
    const error = await opened.writer.appendDurable(makeInvalid(prefix)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({ code: "contract_violation", context: { lastConfirmedSeq: 2, byteOffset: before.length } });
    await expect(opened.writer.appendDurable(tool("tool_start"))).rejects.toBe(error);
    expect(await readFile(source(opened))).toEqual(before);
    expect(await scan(opened)).toMatchObject({ lastSeq: 2, logState: "interrupted" });
  });

  it("旧批次复用的 toolCallId 不能绕过本地 assistantId 指向新批次", async () => {
    const opened = await setup().adapter.create(directory);
    for (const fact of [user(), assistant("a1", true), tool("tool_start"), tool("tool_result"), assistant("a2", true)]) await opened.writer.appendDurable(fact);
    await expect(opened.writer.appendDurable(tool("tool_start", "a1"))).rejects.toMatchObject({ code: "contract_violation", context: { lastConfirmedSeq: 5 } });
    expect((await scan(opened)).lastSeq).toBe(5);
  });
});

describe("T4 短写、sync 和失败前缀", () => {
  it.each([1, 2, 7])("每次最多写 %i 字节，header 和多字节 user 都完整同步，通过扫描", async (limit) => {
    const writes: { position: number; count: number }[] = [];
    const harness = setup({ write: async (handle, remaining, position) => {
      const count = await nodeSessionFileIO.write(handle, remaining.subarray(0, limit), position);
      writes.push({ position, count });
      return count;
    } });
    const opened = await harness.adapter.create(directory);
    await opened.writer.appendDurable(user());
    const bytes = await readFile(source(opened));
    let next = 0;
    for (const write of writes) { expect(write.position).toBe(next); next += write.count; }
    expect(next).toBe(bytes.length);
    expect(await scan(opened)).toMatchObject({ lastSeq: 1, tailKind: "none", validEndBytes: bytes.length });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])("非法写入进度 %s 不无限循环/重试，拒绝后继 append", async (count) => {
    let fail = false;
    const write = vi.fn(async (handle: FileHandle, remaining: Uint8Array, position: number) => fail ? count : nodeSessionFileIO.write(handle, remaining, position));
    const harness = setup({ write });
    const opened = await harness.adapter.create(directory);
    const before = await readFile(source(opened));
    fail = true;
    const error = await opened.writer.appendDurable(user()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "write_failed", context: { lastConfirmedSeq: 0 } });
    await expect(opened.writer.appendDurable(user())).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(2); // header 一次，失败 user 一次
    expect(await readFile(source(opened))).toEqual(before);
    expect((await scan(opened)).lastSeq).toBe(0);
  });

  it("短写后抛错：保留可分析 torn_tail，不重试/截断/补 LF", async () => {
    let fail = false;
    let part = false;
    const harness = setup({ write: async (handle, remaining, position) => {
      if (!fail) return nodeSessionFileIO.write(handle, remaining, position);
      if (part) throw new Error("RAW SECRET WRITE");
      part = true;
      return nodeSessionFileIO.write(handle, remaining.subarray(0, 9), position);
    } });
    const opened = await harness.adapter.create(directory);
    await opened.writer.appendDurable(user());
    const before = await readFile(source(opened));
    fail = true;
    const error = await opened.writer.appendDurable(assistant()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "write_failed", context: { lastConfirmedSeq: 1, byteOffset: before.length } });
    expect(String(error)).not.toContain("RAW SECRET");
    const failed = await readFile(source(opened));
    expect(failed.subarray(0, before.length)).toEqual(before);
    expect(failed.length).toBe(before.length + 9);
    await expect(opened.writer.appendDurable(assistant())).rejects.toBe(error);
    await opened.writer.close();
    expect(await scan(opened)).toMatchObject({ tailKind: "incomplete", lastSeq: 1, validEndBytes: before.length });
    expect(await readFile(source(opened))).toEqual(failed);
    expect(await readdir(root)).toEqual(expect.arrayContaining(["locks", "sessions"]));
    expect(await readdir(root)).not.toContain("recovery");
  });

  it("write 实际完成后确认丢失，不再尝试同 seq；扫描可见完整但未确认记录", async () => {
    let lose = false;
    const write = vi.fn(async (handle: FileHandle, remaining: Uint8Array, position: number) => {
      const count = await nodeSessionFileIO.write(handle, remaining, position);
      if (lose) throw new Error("completion lost");
      return count;
    });
    const opened = await setup({ write }).adapter.create(directory);
    lose = true;
    await expect(opened.writer.appendDurable(user())).rejects.toMatchObject({ code: "write_failed", context: { lastConfirmedSeq: 0 } });
    await expect(opened.writer.appendDurable(user())).rejects.toMatchObject({ code: "write_failed" });
    expect(write).toHaveBeenCalledTimes(2);
    expect((await scan(opened)).lastSeq).toBe(1);
  });

  it("sync 失败时完整行可能存在，confirmedSeq 不推进，后继队列不开始写入", async () => {
    let fail = false;
    const write = vi.fn(nodeSessionFileIO.write);
    const opened = await setup({ write, sync: async (handle) => {
      await nodeSessionFileIO.sync(handle);
      if (fail) throw new Error("RAW SECRET SYNC");
    } }).adapter.create(directory);
    await opened.writer.appendDurable(user());
    fail = true;
    const a = opened.writer.appendDurable(assistant());
    const b = opened.writer.appendDurable(end());
    const results = await Promise.allSettled([a, b]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "sync_failed", context: { lastConfirmedSeq: 1 } } });
    expect(results[1]).toEqual(results[0]);
    expect(write).toHaveBeenCalledTimes(3);
    expect(await scan(opened)).toMatchObject({ lastSeq: 2, logState: "interrupted" });
  });

  it.each(["header-write", "header-sync", "directory-sync"])("创建阶段 %s 失败不交付 writer，遗留前缀可扫描，关闭正文后释放锁", async (point) => {
    let syncCount = 0;
    const harness = setup({
      write: async (handle, remaining, position) => {
        if (point === "header-write") {
          await nodeSessionFileIO.write(handle, remaining.subarray(0, 11), position);
          throw new Error("header write uncertain");
        }
        return nodeSessionFileIO.write(handle, remaining, position);
      },
      sync: async (handle) => {
        syncCount++;
        if (syncCount === (point === "directory-sync" ? 2 : 1) && point !== "header-write") throw new Error("sync uncertain");
        await nodeSessionFileIO.sync(handle);
      },
    });
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: point === "header-write" ? "write_failed" : "sync_failed", context: { lastConfirmedSeq: 0 } });
    const names = await readdir(join(root, "sessions"));
    expect(names).toHaveLength(1);
    const result = await scanSessionFile(join(root, "sessions", names[0]!));
    expect(result.status).toBe(point === "header-write" ? "rejected" : "valid");
    const bodyClose = harness.events.findIndex((event) => event.startsWith("close:") && event.endsWith(".jsonl"));
    expect(bodyClose).toBeGreaterThan(0);
    expect(harness.events.indexOf("release")).toBeGreaterThan(bodyClose);
    expect(locks.at(-1)!.lock.release).toHaveBeenCalledOnce();
  });
});

describe("T4 运行中身份与幂等关闭", () => {
  it.each(["replace", "mode", "owner", "hardlink", "directory", "lock"])("运行中 %s 变化进入永久 ownership_lost，不向新路径追加", async (kind) => {
    let spoofOwner = false;
    const harness = setup({ lstat: async (path) => {
      const info = await nodeSessionFileIO.lstat(path);
      return spoofOwner && path.endsWith(".jsonl") ? Object.create(info, { uid: { value: info.uid + 1n } }) as BigIntStats : info;
    } });
    const opened = await harness.adapter.create(directory);
    const path = source(opened);
    if (kind === "replace") { await rename(path, `${path}.old`); await writeFile(path, "replacement", { mode: 0o600 }); }
    if (kind === "mode") await chmod(path, 0o644);
    if (kind === "owner") spoofOwner = true;
    if (kind === "hardlink") await link(path, `${path}.alias`);
    if (kind === "directory") {
      await rename(join(root, "sessions"), join(root, "old-sessions"));
      await mkdir(join(root, "sessions"), { mode: 0o700 });
    }
    if (kind === "lock") {
      const lockPath = join(root, "locks", `${opened.snapshot.meta.sessionId}.lock`);
      await rename(lockPath, `${lockPath}.old`);
      await writeFile(lockPath, "new lock", { mode: 0o600 });
    }
    const error = await opened.writer.appendDurable(user()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "ownership_lost", context: { lastConfirmedSeq: 0 } });
    if (kind === "mode") await chmod(path, 0o600);
    spoofOwner = false;
    await expect(opened.writer.appendDurable(user())).rejects.toBe(error);
    if (kind === "replace") expect(await readFile(path, "utf8")).toBe("replacement");
    await opened.writer.close();
  });

  it.each(["write", "sync"])("close 等待已发出 %s 结束，重复调用同一 Promise，不提前关闭/解锁", async (stage) => {
    const entered = deferred();
    const release = deferred();
    let hold = false;
    const pause = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } };
    const harness = setup({
      write: async (handle, bytes, position) => { if (stage === "write") await pause(); return nodeSessionFileIO.write(handle, bytes, position); },
      sync: async (handle) => { if (stage === "sync") await pause(); await nodeSessionFileIO.sync(handle); },
    });
    const opened = await harness.adapter.create(directory);
    const eventCount = harness.events.length;
    hold = true;
    const append = opened.writer.appendDurable(user());
    await entered.promise;
    const closing = opened.writer.close();
    expect(opened.writer.close()).toBe(closing);
    try {
      await expect(opened.writer.appendDurable(assistant())).rejects.toMatchObject({ code: "contract_violation" });
      expect(harness.events.slice(eventCount).filter((event) => event.startsWith("close:") || event === "release")).toEqual([]);
      expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("busy");
    } finally { release.resolve(); }
    expect(await append).toEqual({ confirmedSeq: 1 });
    await closing;
    expect(harness.events.slice(-2)).toEqual([`close:${source(opened)}`, "release"]);
    expect(await scan(opened)).toMatchObject({ lastSeq: 1 });
    expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("available");
  });

  it("正文 close 自身未 settle 时仍持锁，不接受新 append", async () => {
    const entered = deferred();
    const release = deferred();
    let hold = false;
    const harness = setup({ close: async (handle) => {
      if (hold) { entered.resolve(); await release.promise; }
      await nodeSessionFileIO.close(handle);
    } });
    const opened = await harness.adapter.create(directory);
    hold = true;
    const closing = opened.writer.close();
    await entered.promise;
    try {
      expect(locks.at(-1)!.lock.release).not.toHaveBeenCalled();
      expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("busy");
      await expect(opened.writer.appendDurable(user())).rejects.toMatchObject({ code: "contract_violation" });
    } finally { release.resolve(); }
    await closing;
    expect(locks.at(-1)!.lock.release).toHaveBeenCalledOnce();
  });

  it("T2 release 的关闭错误上抛，重复 close 不再释放，原锁仍被资源登记", async () => {
    const harness = setup();
    const opened = await harness.adapter.create(directory);
    const error = new PersistenceError("close_failed", "release", "锁描述符关闭失败。");
    vi.mocked(locks.at(-1)!.lock.release).mockRejectedValue(error);
    const first = opened.writer.close();
    await expect(first).rejects.toBe(error);
    expect(opened.writer.close()).toBe(first);
    await expect(harness.adapter.close()).rejects.toBe(error);
    expect(locks.at(-1)!.lock.release).toHaveBeenCalledOnce();
    expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("busy");
  });

  it("正文 close 失败保留锁，重复 close 不重试，文件 adapter 收尾报告同一故障", async () => {
    let fail = false;
    const close = vi.fn(async (handle: FileHandle) => {
      if (fail) throw new Error("RAW CLOSE SECRET");
      await nodeSessionFileIO.close(handle);
    });
    const harness = setup({ close });
    const opened = await harness.adapter.create(directory);
    const calls = close.mock.calls.length;
    fail = true;
    const first = opened.writer.close();
    expect(opened.writer.close()).toBe(first);
    await expect(first).rejects.toMatchObject({ code: "close_failed" });
    await expect(harness.adapter.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(close).toHaveBeenCalledTimes(calls + 1);
    expect(locks.at(-1)!.lock.release).not.toHaveBeenCalled();
    expect(await harness.nativeLocks.probe(opened.snapshot.meta.sessionId)).toBe("busy");
  });

  it("创建中临时目录 close 失败不重复 close，也不因失败未返回 writer 而丢失锁登记", async () => {
    const close = vi.fn(async (handle: FileHandle) => {
      if ((await handle.stat()).isDirectory()) throw new Error("directory close uncertain");
      await nodeSessionFileIO.close(handle);
    });
    const harness = setup({ close });
    await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: "close_failed" });
    await expect(harness.adapter.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(close).toHaveBeenCalledTimes(2); // 目录一次失败，正文一次成功
    expect(locks.at(-1)!.lock.release).not.toHaveBeenCalled();
  });

  it("整体 close 等待尚未交付的 header sync，创建资源也先关正文再解锁", async () => {
    const entered = deferred();
    const release = deferred();
    let first = true;
    const harness = setup({ sync: async (handle) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      await nodeSessionFileIO.sync(handle);
    } });
    const creating = harness.adapter.create(directory);
    await entered.promise;
    const closing = harness.adapter.close();
    expect(harness.adapter.close()).toBe(closing);
    try {
      await expect(harness.adapter.create(directory)).rejects.toMatchObject({ code: "contract_violation" });
      expect(locks.at(-1)!.lock.release).not.toHaveBeenCalled();
      expect(harness.events.some((event) => event.startsWith("close:"))).toBe(false);
    } finally { release.resolve(); }
    const opened = await creating;
    await closing;
    await expect(opened.writer.appendDurable(user())).rejects.toMatchObject({ code: "contract_violation" });
    expect(harness.events.slice(-2)).toEqual([`close:${source(opened)}`, "release"]);
  });

  it("取锁尚未交付时整体 close 仍等待准备登记，释放后不遗漏任何新文件", async () => {
    const entered = deferred();
    const release = deferred();
    const native = new SessionLockAdapter({ storageRoot: root });
    const acquire = native.acquire.bind(native);
    const harness = setup({}, { locks: { preflight: () => native.preflight(), acquire: async (id) => {
      const lock = await acquire(id);
      locks.push({ lock, release: lock.release.bind(lock) });
      entered.resolve();
      await release.promise;
      return lock;
    } } });
    const creating = harness.adapter.create(directory);
    await entered.promise;
    const closing = harness.adapter.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    try { expect(closed).toBe(false); expect(await readdir(join(root, "sessions"))).toEqual([]); }
    finally { release.resolve(); }
    const opened = await creating;
    await closing;
    expect(await native.probe(opened.snapshot.meta.sessionId)).toBe("available");
  });
});
