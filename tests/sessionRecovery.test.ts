import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  appendFile, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm,
  symlink, writeFile, type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileAdapter, type SessionFileOptions } from "../src/adapters/session/SessionFileAdapter.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { nodeSessionFileIO, type SessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import { scanSessionFile } from "../src/adapters/session/scanSession.js";
import { PersistenceError } from "../src/contracts/session.js";
import type { TurnFact } from "../src/contracts/session.js";
import type { SessionLock } from "../src/contracts/session-lock.js";

const createdAt = "2026-10-29T12:00:00.000Z";
const repairedAt = "2026-10-29T13:00:00.000Z";
const profile = { provider: "opencode-go", model: "deepseek-v4-flash" };
const failure = { outcome: "failed", error: { category: "model", code: "network", message: "请求失败。" } };
const cancelled = { outcome: "cancelled", error: { category: "cancellation", code: "user_interrupt", message: "已取消。" } } as const;
const timeout = { outcome: "timeout", error: { category: "timeout", code: "request_timeout", message: "请求超时。" } };
let directory: string;
let root: string;
let sessionId: string;
const adapters: SessionFileAdapter[] = [];
const handles = new Set<FileHandle>();
const heldLocks: { lock: SessionLock; release: () => Promise<void> }[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t5-recovery-")));
  root = join(directory, ".yucli");
  sessionId = randomUUID();
});
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close().catch(() => {});
  // 故障用例有意保留锁；测试最后用原始真实 fd 收尾，不给生产代码增加不安全的重试。
  for (const handle of handles) await handle.close().catch(() => {});
  handles.clear();
  for (const held of heldLocks.splice(0)) await held.release();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

interface Row {
  type: string;
  payload: Record<string, unknown>;
  turnId: string;
  runtimeProfile?: typeof profile;
}
function user(id: string, withProfile = true): Row {
  return { type: "message", turnId: id, payload: { role: "user", content: "读取中文😀\n保留原文" }, ...(withProfile ? { runtimeProfile: profile } : {}) };
}
function assistant(id: string, calls = false): Row {
  return { type: "message", turnId: id, payload: calls
    ? { role: "assistant", toolCalls: [{ id: "reused", name: "read_file", argumentsJson: '{"path":"a.md"}' }] }
    : { role: "assistant", content: "完整回答。" } };
}
function end(id: string, payload: Record<string, unknown> = { outcome: "success" }): Row {
  return { type: "turn_end", turnId: id, payload };
}
function textTurn(id = "old-turn"): Row[] { return [user(id), assistant(id), end(id)]; }
function filename(id = sessionId, time = createdAt) { return `${time.replaceAll(":", "-").replaceAll(".", "-")}_${id}.jsonl`; }
function encoded(rows: Row[], header: Record<string, unknown> = {}): Buffer {
  // 故意保留合法的额外 JSON 空白和字段顺序；备份不能经解析/重新序列化改变这些字节。
  const meta = { type: "session_meta", formatVersion: 1, sessionId, createdAt, cwd: directory, ...header };
  return Buffer.from([JSON.stringify(meta), ...rows.map((row, i) => JSON.stringify({ seq: i + 1, timestamp: createdAt, ...row }))]
    .map((line) => line.replace("{", "{  ")).join("\n") + "\n");
}
async function seed(bytes = encoded(textTurn())) {
  await mkdir(root, { mode: 0o700 }).catch(() => {});
  await mkdir(join(root, "sessions"), { mode: 0o700 }).catch(() => {});
  const path = join(root, "sessions", filename());
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, bytes };
}
function sha(bytes: Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function setup(overrides: Partial<SessionFileIO> = {}, options: Omit<SessionFileOptions, "storageRoot" | "io"> = {}) {
  const paths = new Map<FileHandle, string>();
  const events: string[] = [];
  const native = new SessionLockAdapter({ storageRoot: root });
  const acquire = native.acquire.bind(native);
  vi.spyOn(native, "acquire").mockImplementation(async (id) => {
    const lock = await acquire(id);
    const release = lock.release.bind(lock);
    heldLocks.push({ lock, release });
    vi.spyOn(lock, "release").mockImplementation(async () => { events.push("release"); await release(); });
    return lock;
  });
  const uuid = vi.fn(randomUUID);
  const io: SessionFileIO = {
    ...nodeSessionFileIO, ...overrides,
    open: async (path, flags, mode) => {
      events.push(`open:${path}:${flags}`);
      const handle = await (overrides.open ?? nodeSessionFileIO.open)(path, flags, mode);
      handles.add(handle);
      paths.set(handle, path);
      return handle;
    },
    write: async (handle, bytes, position) => {
      events.push(`write:${paths.get(handle)}:${position}`);
      return (overrides.write ?? nodeSessionFileIO.write)(handle, bytes, position);
    },
    sync: async (handle) => {
      events.push(`sync:${paths.get(handle)}`);
      await (overrides.sync ?? nodeSessionFileIO.sync)(handle);
    },
    truncate: async (handle, size) => {
      events.push(`truncate:${paths.get(handle)}:${size}`);
      await (overrides.truncate ?? nodeSessionFileIO.truncate)(handle, size);
    },
    close: async (handle) => {
      events.push(`close:${paths.get(handle)}`);
      await (overrides.close ?? nodeSessionFileIO.close)(handle);
      events.push(`closed:${paths.get(handle)}`);
    },
  };
  const adapter = new SessionFileAdapter({ storageRoot: root, io, now: () => new Date(repairedAt), uuid, locks: native, ...options });
  adapters.push(adapter);
  return { adapter, paths, events, native, uuid };
}

async function recoveryFiles() {
  const path = join(root, "recovery", sessionId);
  const names = await readdir(path);
  return { directory: path, backup: join(path, names.find((name) => name.endsWith(".bak"))!), manifest: join(path, names.find((name) => name.endsWith(".repair.json"))!) };
}
async function expectHealthy(path: string, lastSeq: number) {
  const result = await scanSessionFile(path, { chunkSizeBytes: 3 });
  expect(result).toMatchObject({ status: "valid", tailKind: "none", lastSeq });
  if (result.status !== "valid") throw new Error("expected valid scan");
  expect(result.validEndBytes).toBe((await lstat(path)).size);
  expect(result.lastLfEndBytes).toBe(result.validEndBytes);
  return result;
}
function nextUser(id: string = randomUUID()): TurnFact {
  return { type: "user", turnId: id, runtimeProfile: { ...profile }, message: { role: "user", content: "新的问题" } };
}

describe("T5 openWrite 安全定位和资源边界", () => {
  it("缺根/缺文件不创建任何会话或目录，返回 not_found", async () => {
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(directory)).toEqual([]);
    await seed();
    const missingId = randomUUID();
    const names = await readdir(root);
    await expect(h.adapter.openWrite({ sessionId: missingId, cwd: directory })).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(root)).toEqual(names);
    expect(h.native.acquire).not.toHaveBeenCalled();
  });

  it.each(["../escape", "", " ", "-bad", "a".repeat(129), "/tmp/session"])("非法 ID 在路径访问前拒绝：%s", async (id) => {
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId: id, cwd: directory })).rejects.toMatchObject({ code: "invalid_identity" });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["relative", "alias", "other", "missing", "file"])("cwd 不合法/归属不匹配拒绝：%s", async (kind) => {
    const source = await seed();
    let cwd = ".";
    if (kind === "alias") { cwd = join(directory, "alias"); await symlink(directory, cwd); }
    if (kind === "other") { cwd = join(directory, "other"); await mkdir(cwd); }
    if (kind === "missing") cwd = join(directory, "missing");
    if (kind === "file") { cwd = join(directory, "file"); await writeFile(cwd, "not a directory"); }
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId, cwd })).rejects.toMatchObject({ code: "cwd_mismatch" });
    expect(await readFile(source.path)).toEqual(source.bytes);
    await expect(lstat(join(root, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("busy 直接拒绝，不打开正文或改选其他会话", async () => {
    const source = await seed();
    const h = setup();
    await h.native.acquire(sessionId);
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "session_busy" });
    expect([...h.paths.values()]).toEqual([]);
    expect(await readFile(source.path)).toEqual(source.bytes);
  });

  it.each([
    ["unknown version", { formatVersion: 2 }, "unsupported"],
    ["header identity", { sessionId: "other" }, "corrupt"],
    ["header time", { createdAt: "2026-10-29T11:00:00.000Z" }, "corrupt"],
    ["extra field", { secret: "not allowed" }, "corrupt"],
  ])("扫描拒绝 %s，不备份/修改", async (_label, header, code) => {
    const source = await seed(encoded(textTurn(), header));
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code });
    expect(await readFile(source.path)).toEqual(source.bytes);
    expect(h.events.some((event) => event.startsWith("write:") || event.startsWith("truncate:"))).toBe(false);
    expect(await h.native.probe(sessionId)).toBe("available");
  });

  it.each(["bad-tail", "middle-line", "incomplete-header", "invalid-sequence"])("损坏的 %s 拒绝整个文件，不恢复局部成功历史", async (kind) => {
    const bytes = kind === "incomplete-header" ? Buffer.from('{"type":"session_meta",')
      : kind === "invalid-sequence" ? encoded(textTurn()).toString().replace('"seq":2', '"seq":8')
      : Buffer.concat([encoded(textTurn()), Buffer.from(kind === "middle-line" ? '{"seq":4,\n' : '{"seq":4,}')]);
    const source = await seed(Buffer.from(bytes));
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(source.path)).toEqual(source.bytes);
    await expect(lstat(join(root, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同 ID 多正文拒绝；另一个带下划线身份和非受管文件不冒充候选", async () => {
    const source = await seed();
    const other = join(root, "sessions", filename(sessionId, "2026-10-29T11:00:00.000Z"));
    await writeFile(other, source.bytes, { mode: 0o600 });
    const h = setup();
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "invalid_identity" });
    expect(h.native.acquire).not.toHaveBeenCalled();
    await rm(other);
    await writeFile(join(root, "sessions", filename(`prefix_${sessionId}`)), "untouched", { mode: 0o600 });
    await writeFile(join(root, "sessions", `${filename()}.bak`), "untouched", { mode: 0o600 });
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot.meta.sessionId).toBe(sessionId);
    await opened.writer.close();
  });

  it("完整文件不备份、不改字节；r+ 不包含创建/截断/追加标志，close 幂等放锁", async () => {
    const source = await seed();
    let flags = 0;
    const h = setup({ open: async (path, value, mode) => {
      if (path === source.path) flags = value;
      return nodeSessionFileIO.open(path, value, mode);
    } });
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot).toMatchObject({ meta: { sessionId, createdAt, cwd: directory }, repair: "none", interruptedTurnCount: 0, lastUserProfile: profile });
    expect(opened.snapshot.recentSuccessfulTurns).toHaveLength(1);
    expect(flags & constants.O_RDWR).toBeTruthy();
    expect(flags & constants.O_NOFOLLOW).toBeTruthy();
    expect(flags & constants.O_NONBLOCK).toBeTruthy();
    expect(flags & (constants.O_CREAT | constants.O_EXCL | constants.O_TRUNC | constants.O_APPEND)).toBe(0);
    expect(h.events.some((event) => event.startsWith("write:") || event.startsWith("truncate:"))).toBe(false);
    expect(h.uuid).not.toHaveBeenCalled();
    expect(await readFile(source.path)).toEqual(source.bytes);
    await expect(lstat(join(root, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.native.probe(sessionId)).toBe("busy");
    const closing = opened.writer.close();
    expect(opened.writer.close()).toBe(closing);
    await closing;
    expect(await h.native.probe(sessionId)).toBe("available");
    expect(h.events.slice(-3)).toEqual([`close:${source.path}`, `closed:${source.path}`, "release"]);
  });
});

describe("T5 恢复快照与后续 writer", () => {
  it("只保留最近 20 组 success，失败/取消/超时不占窗口，中断只计数；最近缺摘要不沿用旧值", async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 23; i++) {
      rows.push(...textTurn(`success-${i}`), user(`failed-${i}`), end(`failed-${i}`, failure));
    }
    rows.push(user("cancelled"), end("cancelled", cancelled), user("timeout"), end("timeout", timeout));
    rows.push(user("interrupted-a"), assistant("interrupted-a", true), user("interrupted-b", false));
    const source = await seed(encoded(rows));
    const { adapter } = setup();
    const opened = await adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot.recentSuccessfulTurns.map((turn) => turn.turnId)).toEqual(Array.from({ length: 20 }, (_, i) => `success-${i + 3}`));
    expect(opened.snapshot.interruptedTurnCount).toBe(2);
    expect(opened.snapshot).not.toHaveProperty("lastUserProfile");
    expect(await readFile(source.path)).toEqual(source.bytes);
    const newFact = nextUser();
    expect(await opened.writer.appendDurable(newFact)).toEqual({ confirmedSeq: rows.length + 1 });
    const scan = await expectHealthy(source.path, rows.length + 1);
    expect(scan.statistics.interruptedTurnCount).toBe(3);
  });

  it("工具结果仍是业务 ToolResult，旧执行不重放，新 a1/同调用 ID 按新 assistant seq 配对", async () => {
    const id = "old-tool-turn";
    const rows = [user(id), assistant(id, true),
      { type: "tool_start", turnId: id, payload: { callMessageSeq: 2, toolCallId: "reused", name: "read_file" } },
      { type: "tool_result", turnId: id, payload: { callMessageSeq: 2, toolCallId: "reused", name: "read_file", ok: false, content: "" } }, assistant(id), end(id)];
    const source = await seed(encoded(rows));
    const opened = await setup().adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot.recentSuccessfulTurns[0]!.items[2]).toEqual({ type: "tool_result", result: { toolCallId: "reused", name: "read_file", ok: false, content: "" } });
    expect(JSON.stringify(opened.snapshot)).not.toMatch(/callMessageSeq|assistantId|"seq"|"role":"tool"/u);
    const turnId = randomUUID();
    const call = { assistantId: "a1", toolCallId: "reused", name: "read_file" };
    const facts: TurnFact[] = [nextUser(turnId),
      { type: "assistant", turnId, assistantId: "a1", message: { role: "assistant", toolCalls: [{ id: "reused", name: "read_file", argumentsJson: '{"path":"b.md"}' }] } },
      { type: "tool_start", turnId, call },
      { type: "tool_result", turnId, call, result: { toolCallId: "reused", name: "read_file", ok: true, content: "新的结果" } },
      { type: "assistant", turnId, assistantId: "a2", message: { role: "assistant", content: "新的回答" } },
      { type: "turn_end", turnId, end: { outcome: "success" } }];
    for (const [i, fact] of facts.entries()) expect(await opened.writer.appendDurable(fact)).toEqual({ confirmedSeq: rows.length + i + 1 });
    expect((await readFile(source.path)).subarray(0, source.bytes.length)).toEqual(source.bytes);
    const scan = await expectHealthy(source.path, 12);
    expect(scan.turns[1]!.calls[0]).toMatchObject({ callMessageSeq: 8, state: "result" });
  });

  it.each(["success", "interrupted"])("%s 的旧 turnId 不能复用，修改快照不改变拒绝集合", async (kind) => {
    const source = await seed(encoded(kind === "success" ? textTurn() : [user("old-turn")]));
    const h = setup();
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    // 即使调用方修改快照中的旧身份，writer 的旧 turnId 集合也不能受影响。
    if (opened.snapshot.recentSuccessfulTurns[0]) opened.snapshot.recentSuccessfulTurns[0].turnId = "changed-by-caller";
    await expect(opened.writer.appendDurable(nextUser("old-turn"))).rejects.toMatchObject({ code: "contract_violation" });
    await expect(opened.writer.appendDurable(nextUser())).rejects.toMatchObject({ code: "contract_violation" });
    expect(await readFile(source.path)).toEqual(source.bytes);
  });

  it("header-only 恢复从 seq=1 开始，不备份，不构造历史", async () => {
    const source = await seed(encoded([]));
    const opened = await setup().adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot).toMatchObject({ recentSuccessfulTurns: [], interruptedTurnCount: 0, repair: "none" });
    expect(opened.snapshot).not.toHaveProperty("lastUserProfile");
    expect(await opened.writer.appendDurable(nextUser())).toEqual({ confirmedSeq: 1 });
    expect((await readFile(source.path)).subarray(0, source.bytes.length)).toEqual(source.bytes);
    await expectHealthy(source.path, 1);
  });
});

describe("T5 D04 已有目录/正文与 inode 复核", () => {
  it.each(["root-link", "sessions-link", "body-link", "body-directory", "root-mode", "sessions-mode", "body-mode", "body-hardlink", "root-owner", "sessions-owner", "body-owner"])("拒绝 %s，不 chmod、不改正文", async (kind) => {
    const source = await seed();
    const path = kind.startsWith("root") ? root : kind.startsWith("sessions") ? join(root, "sessions") : source.path;
    if (kind.endsWith("link") && !kind.endsWith("hardlink")) { await rename(path, `${path}.old`); await symlink(`${path}.old`, path); }
    if (kind === "body-directory") { await rename(path, `${path}.old`); await mkdir(path, { mode: 0o700 }); }
    if (kind.endsWith("mode")) await chmod(path, kind === "body-mode" ? 0o644 : 0o755);
    if (kind === "body-hardlink") await link(path, `${path}.alias`);
    const h = setup({ lstat: async (candidate) => {
      const info = await nodeSessionFileIO.lstat(candidate);
      return kind.endsWith("owner") && candidate === path ? Object.create(info, { uid: { value: info.uid + 1n } }) as BigIntStats : info;
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "permission_denied" });
    expect(h.events.some((event) => event.startsWith("write:") || event.startsWith("truncate:"))).toBe(false);
    if (kind.endsWith("mode")) expect((await lstat(path)).mode & 0o777).toBe(kind === "body-mode" ? 0o644 : 0o755);
  });

  it.each(["replace", "grow", "disappear", "directory-replace"])("定位和打开之间 %s 拒绝，不创建/修改新目标", async (kind) => {
    const source = await seed();
    const h = setup({ open: async (path, flags, mode) => {
      if (path === source.path && kind === "disappear") await rm(path);
      const handle = await nodeSessionFileIO.open(path, flags, mode);
      if (path === source.path) {
        if (kind === "replace") { await rename(path, `${path}.old`); await writeFile(path, "replacement", { mode: 0o600 }); }
        if (kind === "grow") await appendFile(path, "external");
        if (kind === "directory-replace") { await rename(join(root, "sessions"), join(root, "old-sessions")); await mkdir(join(root, "sessions"), { mode: 0o700 }); }
      }
      return handle;
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: kind === "disappear" ? "not_found" : "ownership_lost" });
    if (kind === "disappear") await expect(lstat(source.path)).rejects.toMatchObject({ code: "ENOENT" });
    if (kind === "replace") expect(await readFile(source.path, "utf8")).toBe("replacement");
    expect(await h.native.probe(sessionId)).toBe("available");
  });

  it("扫描过程中追加数据拒绝 changing，不复用可读前缀续写", async () => {
    const source = await seed();
    const h = setup({ open: async (path, flags, mode) => {
      const handle = await nodeSessionFileIO.open(path, flags, mode);
      if (path === source.path) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
          await appendFile(path, "external");
          return read(...args);
        });
      }
      return handle;
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "ownership_lost" });
    expect(await readFile(source.path)).toEqual(Buffer.concat([source.bytes, Buffer.from("external")]));
    expect(h.events.some((event) => event.startsWith("write:") || event.startsWith("truncate:"))).toBe(false);
  });

  it("扫描失败时正文 close 失败优先返回 close_failed，继续登记资源/持锁，不重复 close", async () => {
    const source = await seed(Buffer.concat([encoded(textTurn()), Buffer.from("bad\n")]));
    const close = vi.fn(async (handle: FileHandle) => {
      if ((await handle.stat()).isFile()) throw new Error("RAW CLOSE SECRET");
      await nodeSessionFileIO.close(handle);
    });
    const h = setup({ close });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "close_failed" });
    await expect(h.adapter.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(close).toHaveBeenCalledOnce();
    expect(heldLocks.at(-1)!.lock.release).not.toHaveBeenCalled();
    expect(await h.native.probe(sessionId)).toBe("busy");
    expect(await readFile(source.path)).toEqual(source.bytes);
  });
});

describe("T5 B06/B09 完整备份、补 LF 与截断", () => {
  it.each(["missing-record-lf", "missing-header-lf", "incomplete-json", "incomplete-utf8"])("修复 %s，备份精确包含 [0,S)，重扫和续写 seq 正确", async (kind) => {
    const prefix = encoded(kind === "missing-header-lf" ? [] : textTurn());
    const fragment = kind === "incomplete-utf8"
      ? Buffer.concat([Buffer.from('{"seq":4,"payload":{"content":"'), Buffer.from([0xe4, 0xb8])])
      : Buffer.from('{"seq":4,');
    const missing = kind.startsWith("missing");
    const original = missing ? prefix.subarray(0, prefix.length - 1) : Buffer.concat([prefix, fragment]);
    const source = await seed(original);
    const h = setup();
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    const action = missing ? "append_lf" : "truncate_tail";
    const lastSeq = kind === "missing-header-lf" ? 0 : 3;
    const repaired = missing ? Buffer.concat([original, Buffer.from("\n")]) : prefix;
    expect(opened.snapshot.repair).toBe(action);
    expect(await readFile(source.path)).toEqual(repaired);
    const files = await recoveryFiles();
    expect(await readFile(files.backup)).toEqual(original);
    expect((await lstat(files.backup)).size).toBe(original.length);
    if (kind !== "missing-header-lf") expect(original.length).toBeGreaterThan(original.toString().length);
    const manifest = JSON.parse(await readFile(files.manifest, "utf8")) as Record<string, unknown>;
    expect(manifest).toEqual({
      version: 1, sessionId, sourceBasename: filename(), createdAt: repairedAt, action,
      originalSizeBytes: original.length, validEndBytes: missing ? original.length : prefix.length,
      lastSeq, sourceSha256: sha(original),
    });
    const backupName = basename(files.backup).replace(".jsonl.bak", "");
    expect(basename(files.manifest)).toBe(`${backupName}.repair.json`);
    expect(backupName).toBe(`${repairedAt.replaceAll(":", "-").replaceAll(".", "-")}_${h.uuid.mock.results[0]!.value}`);
    expect(h.uuid).toHaveBeenCalledOnce();
    for (const path of [join(root, "recovery"), files.directory]) expect((await lstat(path)).mode & 0o777).toBe(0o700);
    for (const path of [files.backup, files.manifest]) expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const mutation = h.events.findIndex((event) => missing ? event.startsWith(`write:${source.path}:`) : event.startsWith(`truncate:${source.path}:`));
    for (const path of [files.backup, files.manifest, files.directory, join(root, "recovery"), root]) {
      expect(h.events.indexOf(`sync:${path}`)).toBeGreaterThan(-1);
      expect(h.events.indexOf(`sync:${path}`)).toBeLessThan(mutation);
    }
    expect(h.events.indexOf(`closed:${files.backup}`)).toBeLessThan(mutation);
    expect(h.events.indexOf(`closed:${files.manifest}`)).toBeLessThan(mutation);
    expect(h.events.indexOf(`sync:${source.path}`)).toBeGreaterThan(mutation);
    await expectHealthy(source.path, lastSeq);
    const newTurn = nextUser();
    expect(await opened.writer.appendDurable(newTurn)).toEqual({ confirmedSeq: lastSeq + 1 });
    expect((await readFile(source.path)).subarray(0, repaired.length)).toEqual(repaired);
    await expectHealthy(source.path, lastSeq + 1);
    await opened.writer.close();
    const again = await h.adapter.openWrite({ sessionId, cwd: directory });
    expect(again.snapshot.repair).toBe("none");
    expect(await readdir(files.directory)).toHaveLength(2);
    expect(h.uuid).toHaveBeenCalledOnce();
  });

  it("中断工具 start 后的残片只截尾，保留未知证据，不补 turn_end 或结果", async () => {
    const id = "interrupted-tool";
    const rows = [user(id), assistant(id, true), { type: "tool_start", turnId: id, payload: { callMessageSeq: 2, toolCallId: "reused", name: "read_file" } }];
    const prefix = encoded(rows);
    const source = await seed(Buffer.concat([prefix, Buffer.from('{"seq":4,"type":"tool_result",')]));
    const opened = await setup().adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot).toMatchObject({ interruptedTurnCount: 1, recentSuccessfulTurns: [], repair: "truncate_tail" });
    expect(await readFile(source.path)).toEqual(prefix);
    const scan = await expectHealthy(source.path, 3);
    expect(scan.turns[0]!.calls[0]).toMatchObject({ state: "unknown" });
    await expect(opened.writer.appendDurable({ type: "tool_start", turnId: id, call: { assistantId: "a1", toolCallId: "reused", name: "read_file" } })).rejects.toMatchObject({ code: "contract_violation" });
  });

  it("大原件按块复制，短读/短写仍包含全部原始 UTF-8 字节和残片", async () => {
    const rows = textTurn();
    rows[0]!.payload.content = "原文😀".repeat(12_000);
    const prefix = encoded(rows);
    const source = await seed(Buffer.concat([prefix, Buffer.from('{"seq":4,')]));
    let maxRead = 0;
    const h = setup({
      read: async (handle, buffer, position) => {
        maxRead = Math.max(maxRead, buffer.length);
        return nodeSessionFileIO.read(handle, buffer.subarray(0, 997), position);
      },
      write: (handle, bytes, position) => nodeSessionFileIO.write(handle, bytes.subarray(0, 401), position),
    });
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot.repair).toBe("truncate_tail");
    expect(maxRead).toBeLessThanOrEqual(64 * 1024);
    expect(source.bytes.length).toBeGreaterThan(maxRead);
    const files = await recoveryFiles();
    expect(await readFile(files.backup)).toEqual(source.bytes);
    expect(await readFile(source.path)).toEqual(prefix);
    expect(JSON.parse(await readFile(files.manifest, "utf8"))).toMatchObject({ sourceSha256: sha(source.bytes), originalSizeBytes: source.bytes.length });
  });
});

describe("T5 B07 修改前的故障均保全正文", () => {
  it.each([
    "backup-open", "copy-read", "backup-write", "backup-partial-write", "backup-zero-write", "backup-sync", "backup-digest",
    "manifest-open", "manifest-write", "manifest-sync", "manifest-digest", "directory-open", "directory-sync", "root-sync", "source-digest",
  ])("%s 失败为 repair_failed，不修改正文、不交付 writer、不删残留产物", async (stage) => {
    const prefix = encoded(textTurn());
    const source = await seed(Buffer.concat([prefix, Buffer.from('{"seq":4,')]));
    let bodyPass = 0;
    let partial = false;
    const h: ReturnType<typeof setup> = setup({
      open: async (path, flags, mode) => {
        if (stage === "backup-open" && path.endsWith(".bak")) throw Object.assign(new Error("RAW ENOSPC SECRET"), { code: "ENOSPC" });
        if (stage === "manifest-open" && path.endsWith(".repair.json")) throw new Error("manifest create failure");
        if (stage === "directory-open" && path === join(root, "recovery", sessionId)) throw new Error("directory open failure");
        return nodeSessionFileIO.open(path, flags, mode);
      },
      read: async (handle, buffer, position) => {
        const path = h.paths.get(handle)!;
        if (path === source.path && position === 0) bodyPass++;
        if (stage === "copy-read" && path === source.path && bodyPass === 2) throw new Error("copy failure");
        const count = await nodeSessionFileIO.read(handle, buffer, position);
        if (
          stage === "backup-digest" && path.endsWith(".bak") ||
          stage === "manifest-digest" && path.endsWith(".repair.json") ||
          stage === "source-digest" && path === source.path && bodyPass === 3
        ) buffer[0] = buffer[0]! ^ 1;
        return count;
      },
      write: async (handle, bytes, position) => {
        const path = h.paths.get(handle)!;
        if (stage === "backup-write" && path.endsWith(".bak")) throw new Error("backup write failure");
        if (stage === "backup-zero-write" && path.endsWith(".bak")) return 0;
        if (stage === "backup-partial-write" && path.endsWith(".bak")) {
          if (partial) throw new Error("backup partial failure");
          partial = true;
          return nodeSessionFileIO.write(handle, bytes.subarray(0, 7), position);
        }
        if (stage === "manifest-write" && path.endsWith(".repair.json")) throw new Error("manifest write failure");
        return nodeSessionFileIO.write(handle, bytes, position);
      },
      sync: async (handle) => {
        const path = h.paths.get(handle)!;
        if (
          stage === "backup-sync" && path.endsWith(".bak") || stage === "manifest-sync" && path.endsWith(".repair.json") ||
          stage === "directory-sync" && path === join(root, "recovery", sessionId) || stage === "root-sync" && path === root
        ) throw new Error("sync failure");
        await nodeSessionFileIO.sync(handle);
      },
    });
    const error = await h.adapter.openWrite({ sessionId, cwd: directory }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({ code: "repair_failed", operation: "repair" });
    expect(String(error)).not.toContain("SECRET");
    expect(await readFile(source.path)).toEqual(source.bytes);
    expect(h.events.some((event) => event.startsWith(`write:${source.path}:`) || event.startsWith(`truncate:${source.path}:`))).toBe(false);
    expect(await h.native.probe(sessionId)).toBe("available");
    const files = await readdir(join(root, "recovery", sessionId));
    if (stage === "backup-open") expect(files).toEqual([]);
    else expect(files.some((name) => name.endsWith(".bak"))).toBe(true);
    if (stage === "backup-partial-write") {
      const backup = files.find((name) => name.endsWith(".bak"))!;
      expect(await readFile(join(root, "recovery", sessionId, backup))).toEqual(source.bytes.subarray(0, 7));
    }
  });

  it.each(["source-content", "source-inode", "source-size", "lock-inode"])("备份后 %s 变化停止，保留外部修改，不实施旧修复边界", async (kind) => {
    const prefix = encoded(textTurn());
    const source = await seed(Buffer.concat([prefix, Buffer.from('{"seq":4,')]));
    let expected = source.bytes;
    const h: ReturnType<typeof setup> = setup({ sync: async (handle) => {
      await nodeSessionFileIO.sync(handle);
      if (h.paths.get(handle)!.endsWith(".repair.json")) {
        if (kind === "source-content") {
          expected = Buffer.from(source.bytes.toString().replace("完整回答", "外部改写"));
          expect(expected.length).toBe(source.bytes.length);
          await writeFile(source.path, expected);
        }
        if (kind === "source-inode") { await rename(source.path, `${source.path}.old`); await writeFile(source.path, source.bytes, { mode: 0o600 }); }
        if (kind === "source-size") { expected = Buffer.concat([source.bytes, Buffer.from("external")]); await appendFile(source.path, "external"); }
        if (kind === "lock-inode") {
          const path = join(root, "locks", `${sessionId}.lock`);
          await rename(path, `${path}.old`);
          await writeFile(path, "replacement", { mode: 0o600 });
        }
      }
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "repair_failed" });
    expect(await readFile(source.path)).toEqual(expected);
    expect(h.events.some((event) => event.startsWith(`write:${source.path}:`) || event.startsWith(`truncate:${source.path}:`))).toBe(false);
    const files = await recoveryFiles();
    expect(await readFile(files.backup)).toEqual(source.bytes);
  });

  it.each(["recovery-link", "session-link", "recovery-mode", "session-mode", "recovery-owner", "session-owner"])("拒绝不安全备份目录 %s，正文不变", async (kind) => {
    const source = await seed(Buffer.concat([encoded(textTurn()), Buffer.from('{"seq":4,')]));
    const recovery = join(root, "recovery");
    const path = kind.startsWith("recovery") ? recovery : join(recovery, sessionId);
    const target = join(directory, "outside");
    await mkdir(target, { mode: 0o700 });
    if (path !== recovery) await mkdir(recovery, { mode: 0o700 });
    if (kind.endsWith("link")) await symlink(target, path);
    else { await mkdir(path, { mode: 0o700 }); if (kind.endsWith("mode")) await chmod(path, 0o755); }
    const h = setup({ lstat: async (candidate) => {
      const info = await nodeSessionFileIO.lstat(candidate);
      return kind.endsWith("owner") && candidate === path ? Object.create(info, { uid: { value: info.uid + 1n } }) as BigIntStats : info;
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "repair_failed" });
    expect(await readFile(source.path)).toEqual(source.bytes);
    expect(await readdir(target)).toEqual([]);
    if (kind.endsWith("mode")) expect((await lstat(path)).mode & 0o777).toBe(0o755);
  });

  it.each(["backup-file", "backup-link", "manifest-file", "manifest-link"])("wx 产物碰撞 %s 不覆盖、不重试身份，正文不变", async (kind) => {
    const source = await seed(Buffer.concat([encoded(textTurn()), Buffer.from('{"seq":4,')]));
    const id = randomUUID();
    const uuid = vi.fn(() => id);
    const path = join(root, "recovery", sessionId);
    await mkdir(join(root, "recovery"), { mode: 0o700 });
    await mkdir(path, { mode: 0o700 });
    const target = join(directory, "outside-file");
    await writeFile(target, "untouched", { mode: 0o600 });
    const name = `${repairedAt.replaceAll(":", "-").replaceAll(".", "-")}_${id}${kind.startsWith("backup") ? ".jsonl.bak" : ".repair.json"}`;
    if (kind.endsWith("link")) await symlink(target, join(path, name));
    else await writeFile(join(path, name), "untouched", { mode: 0o600 });
    const h = setup({}, { uuid });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "repair_failed" });
    expect(await readFile(source.path)).toEqual(source.bytes);
    expect(await readFile(join(path, name), "utf8")).toBe("untouched");
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect(uuid).toHaveBeenCalledOnce();
  });

  it("备份临时目录关闭失败不改正文，不再次 close 或提前放锁", async () => {
    const source = await seed(Buffer.concat([encoded(textTurn()), Buffer.from('{"seq":4,')]));
    const close = vi.fn(async (handle: FileHandle) => {
      if (h.paths.get(handle) === join(root, "recovery", sessionId)) throw new Error("directory close uncertain");
      await nodeSessionFileIO.close(handle);
    });
    const h: ReturnType<typeof setup> = setup({ close });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "close_failed" });
    const count = close.mock.calls.length;
    await expect(h.adapter.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(close).toHaveBeenCalledTimes(count);
    expect(heldLocks.at(-1)!.lock.release).not.toHaveBeenCalled();
    expect(await h.native.probe(sessionId)).toBe("busy");
    expect(await readFile(source.path)).toEqual(source.bytes);
  });
});

describe("T5 B08 修改/重验故障不回滚、不复用旧边界", () => {
  it.each([
    "truncate-before", "truncate-after", "truncate-noop", "append-before", "append-after", "append-noop",
    "body-sync", "rescan-read", "rescan-tail", "repaired-digest",
  ])("%s 失败不交付 writer，保留完整备份及当时真实字节", async (stage) => {
    const prefix = encoded(textTurn());
    const append = stage.startsWith("append") || stage === "rescan-tail";
    const original = append ? prefix.subarray(0, prefix.length - 1) : Buffer.concat([prefix, Buffer.from('{"seq":4,')]);
    const source = await seed(original);
    let mutated = false;
    const h: ReturnType<typeof setup> = setup({
      open: async (path, flags, mode) => {
        const handle = await nodeSessionFileIO.open(path, flags, mode);
        if (path === source.path && stage === "rescan-read") {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
            if (mutated) throw new Error("RAW RESCAN SECRET");
            return read(...args);
          });
        }
        return handle;
      },
      write: async (handle, bytes, position) => {
        if (h.paths.get(handle) === source.path) {
          if (stage === "append-before") throw new Error("append failed before write");
          if (stage === "append-noop") return bytes.length;
          const count = await nodeSessionFileIO.write(handle, stage === "rescan-tail" ? Buffer.from(" ") : bytes, position);
          mutated = true;
          if (stage === "append-after") throw new Error("append acknowledgement lost");
          return count;
        }
        return nodeSessionFileIO.write(handle, bytes, position);
      },
      truncate: async (handle, size) => {
        if (stage === "truncate-before") throw new Error("truncate failed before mutation");
        if (stage === "truncate-noop") return;
        await nodeSessionFileIO.truncate(handle, size);
        mutated = true;
        if (stage === "truncate-after") throw new Error("truncate acknowledgement lost");
      },
      sync: async (handle) => {
        await nodeSessionFileIO.sync(handle);
        if (mutated && h.paths.get(handle) === source.path && stage === "body-sync") throw new Error("body sync acknowledgement lost");
      },
      read: async (handle, buffer, position) => {
        const count = await nodeSessionFileIO.read(handle, buffer, position);
        if (mutated && h.paths.get(handle) === source.path && stage === "repaired-digest") buffer[0] = buffer[0]! ^ 1;
        return count;
      },
    });
    const error = await h.adapter.openWrite({ sessionId, cwd: directory }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PersistenceError);
    expect(error).toMatchObject({ code: "repair_failed", operation: "repair" });
    expect(String(error)).not.toContain("SECRET");
    const expected = !mutated ? original : stage === "rescan-tail" ? Buffer.concat([original, Buffer.from(" ")]) : prefix;
    expect(await readFile(source.path)).toEqual(expected);
    const files = await recoveryFiles();
    expect(await readFile(files.backup)).toEqual(original);
    expect(JSON.parse(await readFile(files.manifest, "utf8"))).toMatchObject({ sourceSha256: sha(original), originalSizeBytes: original.length });
    const mutations = h.events.filter((event) => event.startsWith(`write:${source.path}:`) || event.startsWith(`truncate:${source.path}:`));
    expect(mutations).toHaveLength(1);
    expect(await h.native.probe(sessionId)).toBe("available");

    // 模拟“修改已完成但进程未获得确认”的下一次启动：按实际健康字节打开，不重复备份/动作。
    if (mutated && stage !== "rescan-tail") {
      const next = setup();
      const opened = await next.adapter.openWrite({ sessionId, cwd: directory });
      expect(opened.snapshot.repair).toBe("none");
      expect(await readdir(files.directory)).toHaveLength(2);
      expect(next.uuid).not.toHaveBeenCalled();
      await expectHealthy(source.path, 3);
    }
  });

  it("完整文件的 sync 失败沿用 sync_failed，不启动修复或暴露 writer", async () => {
    const source = await seed();
    const h = setup({ sync: async () => { throw new Error("sync failed"); } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "sync_failed", operation: "open_write" });
    expect(await readFile(source.path)).toEqual(source.bytes);
    await expect(lstat(join(root, "recovery"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.native.probe(sessionId)).toBe("available");
  });

  it("恢复 writer 的后继 append 失败永久停止，不重试已落盘的 seq", async () => {
    const source = await seed();
    let fail = false;
    const h: ReturnType<typeof setup> = setup({ sync: async (handle) => {
      await nodeSessionFileIO.sync(handle);
      if (fail && h.paths.get(handle) === source.path) throw new Error("append sync failed");
    } });
    const opened = await h.adapter.openWrite({ sessionId, cwd: directory });
    const turnId = randomUUID();
    expect(await opened.writer.appendDurable(nextUser(turnId))).toEqual({ confirmedSeq: 4 });
    fail = true;
    const error = await opened.writer.appendDurable({ type: "assistant", turnId, assistantId: "a1", message: { role: "assistant", content: "未确认回答" } }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "sync_failed", context: { lastConfirmedSeq: 4 } });
    await expect(opened.writer.appendDurable({ type: "turn_end", turnId, end: { outcome: "success" } })).rejects.toBe(error);
    expect(h.events.filter((event) => event.startsWith(`write:${source.path}:`))).toHaveLength(2);
    await expectHealthy(source.path, 5);
    await opened.writer.close();
    expect(await h.native.probe(sessionId)).toBe("available");
  });
});

describe("T5 实际 settle 与整体关闭", () => {
  it.each(["backup-write", "truncate", "rescan"])("整体 close 等待 %s 真正结束才关闭正文/放锁", async (stage) => {
    const source = await seed(Buffer.concat([encoded(textTurn()), Buffer.from('{"seq":4,')]));
    const entered = deferred();
    const release = deferred();
    let mutated = false;
    let paused = false;
    const pause = async () => { if (!paused) { paused = true; entered.resolve(); await release.promise; } };
    const h: ReturnType<typeof setup> = setup({
      open: async (path, flags, mode) => {
        const handle = await nodeSessionFileIO.open(path, flags, mode);
        if (path === source.path && stage === "rescan") {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...args: Parameters<typeof handle.read>) => {
            if (mutated) await pause();
            return read(...args);
          });
        }
        return handle;
      },
      write: async (handle, bytes, position) => {
        const count = await nodeSessionFileIO.write(handle, bytes, position);
        if (stage === "backup-write" && h.paths.get(handle)!.endsWith(".bak")) await pause();
        return count;
      },
      truncate: async (handle, size) => {
        await nodeSessionFileIO.truncate(handle, size);
        mutated = true;
        if (stage === "truncate") await pause();
      },
    });
    const opening = h.adapter.openWrite({ sessionId, cwd: directory });
    await entered.promise;
    const closing = h.adapter.close();
    expect(h.adapter.close()).toBe(closing);
    try {
      await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: "contract_violation" });
      expect(heldLocks.at(-1)!.lock.release).not.toHaveBeenCalled();
      expect(h.events).not.toContain(`close:${source.path}`);
      expect(await h.native.probe(sessionId)).toBe("busy");
    } finally { release.resolve(); }
    const opened = await opening;
    await closing;
    await expect(opened.writer.appendDurable(nextUser())).rejects.toMatchObject({ code: "contract_violation" });
    expect(h.events.slice(-3)).toEqual([`close:${source.path}`, `closed:${source.path}`, "release"]);
    expect(await h.native.probe(sessionId)).toBe("available");
  });
});

describe("T5 持锁重定位与 T3 格式兼容", () => {
  it.each(["duplicate", "renamed"])("取得锁前后的候选 %s 不能被初次目录观察放行", async (kind) => {
    const source = await seed();
    const native = new SessionLockAdapter({ storageRoot: root });
    const h = setup({}, { locks: {
      preflight: () => native.preflight(),
      acquire: async (id) => {
        const lock = await native.acquire(id);
        heldLocks.push({ lock, release: lock.release.bind(lock) });
        const target = join(root, "sessions", filename(sessionId, "2026-10-29T11:00:00.000Z"));
        if (kind === "duplicate") await writeFile(target, source.bytes, { mode: 0o600 });
        else await rename(source.path, target);
        return lock;
      },
    } });
    await expect(h.adapter.openWrite({ sessionId, cwd: directory })).rejects.toMatchObject({ code: kind === "duplicate" ? "invalid_identity" : "ownership_lost" });
    expect([...h.paths.values()]).toEqual([]);
    expect(await native.probe(sessionId)).toBe("available");
  });

  it.each(["2026-10-29T12:00:00Z", "2026-10-29T12:00:00.1Z", "2026-10-29T12:00:00.123456Z"])("恢复保留 T3 合法创建时间精度：%s", async (time) => {
    const source = await seed(encoded(textTurn(), { createdAt: time }));
    const path = join(root, "sessions", filename(sessionId, time));
    await rename(source.path, path);
    const opened = await setup().adapter.openWrite({ sessionId, cwd: directory });
    expect(opened.snapshot.meta.createdAt).toBe(time);
    expect(await readFile(path)).toEqual(source.bytes);
    expect(await opened.writer.appendDurable(nextUser())).toEqual({ confirmedSeq: 4 });
    await expectHealthy(path, 4);
  });

  it("不接受补写旧中断 turn_end；必须从新的 user/turnId 开始", async () => {
    const source = await seed(encoded([user("old-turn")]));
    const opened = await setup().adapter.openWrite({ sessionId, cwd: directory });
    await expect(opened.writer.appendDurable({ type: "turn_end", turnId: "old-turn", end: cancelled })).rejects.toMatchObject({ code: "contract_violation" });
    expect(await readFile(source.path)).toEqual(source.bytes);
  });
});
