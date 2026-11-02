import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FileHandle } from "node:fs/promises";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { sessionBasename } from "../src/adapters/session/sessionFilename.js";
import { nodeSessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import { PersistenceError } from "../src/contracts/session.js";
import type { SessionMeta } from "../src/contracts/session.js";
import { deferred, flush, TestClock } from "./persistenceHelpers.js";

let cwd: string; let root: string; const stores: SessionFileAdapter[] = [];
beforeEach(async () => { cwd = await realpath(await mkdtemp(join(tmpdir(), "yucli-list-"))); root = join(cwd, ".yucli"); });
afterEach(async () => { for (const store of stores.splice(0)) await store.closeSettled().catch(() => {}); await rm(cwd, { recursive: true, force: true }); });
/** 只构造临时 JSONL fixture；列表本身不得创建任何目录/锁或修改这些字节。 */
async function file(id: string, options: { cwd?: string; createdAt?: string; activity?: string; empty?: boolean; tail?: string } = {}) {
  await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
  const meta: SessionMeta = { sessionId: id, cwd: options.cwd ?? cwd, createdAt: options.createdAt ?? "2026-10-29T12:00:00.000Z" };
  const header = JSON.stringify({ type: "session_meta", formatVersion: 1, ...meta });
  const user = JSON.stringify({ seq: 1, type: "message", turnId: `turn-${id}`, timestamp: options.activity ?? meta.createdAt, payload: { role: "user", content: "first\u001b\n问题😀" } });
  const content = header + "\n" + (options.empty ? "" : user + "\n") + (options.tail ?? "");
  const path = join(root, "sessions", sessionBasename(meta)); await writeFile(path, content, { mode: 0o600 });
  return { meta, path, content };
}
/** 注入 probe 和禁写 spy，验证只读路径不会误用 T2 acquire 或创建 sidecar。 */
function store(probe: "available" | "busy" | "unknown" = "available", extra: ConstructorParameters<typeof SessionFileAdapter>[0] = {}) {
  const acquire = vi.fn(async () => { throw new Error("不得取写锁"); });
  const mkdir = vi.fn(nodeSessionFileIO.mkdir); const write = vi.fn(nodeSessionFileIO.write);
  const locks = { preflight: vi.fn(async () => { throw new Error("列表不做写预检"); }), acquire, probe: vi.fn(async () => probe) };
  const adapter = new SessionFileAdapter({ storageRoot: root, locks, ...extra, io: { mkdir, write, ...extra.io } }); stores.push(adapter);
  return { adapter, acquire, mkdir, write, locks };
}
describe("T8 只读 SessionStore.list", () => {
  it("不存在目录返回空快照，不创建目录/锁，不调用写预检或 acquire", async () => {
    const ctx = store(); expect(await ctx.adapter.list({ cwd, all: false })).toEqual({ entries: [], diagnostics: [], hiddenEmptyCount: 0, unattributedCount: 0 });
    expect(await readdir(cwd)).toEqual([]); expect(ctx.acquire).not.toHaveBeenCalled(); expect(ctx.mkdir).not.toHaveBeenCalled(); expect(ctx.locks.preflight).not.toHaveBeenCalled();
  });
  it("缺 sessions 也先拒绝已有不安全根，不能伪装合法空列表", async () => {
    await mkdir(root, { mode: 0o755 });
    await expect(store().adapter.list({ cwd, all: false })).rejects.toMatchObject({ code: "ownership_lost", operation: "list" });
    expect(await readdir(root)).toEqual([]);
  });
  it("空容器也是只读空列表", async () => {
    await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 }); const ctx = store();
    expect((await ctx.adapter.list({ cwd, all: true })).entries).toEqual([]); expect(await readdir(root)).toEqual(["sessions"]);
  });
  it("current 只全扫当前 cwd，all 扫描其他 cwd，empty 默认隐藏并计数", async () => {
    const active = await file("active"); const empty = await file("empty", { empty: true });
    await file("other", { cwd: "/other", tail: "bad\n" });
    const ctx = store(); const current = await ctx.adapter.list({ cwd, all: false });
    expect(current.entries.map((e) => e.sessionId)).toEqual(["active"]); expect(current.hiddenEmptyCount).toBe(1); expect(current.diagnostics).toEqual([]);
    const global = await ctx.adapter.list({ cwd, all: true }); expect(global.entries.map((e) => e.sessionId)).toEqual(["active", "empty"]);
    expect(global.entries[1]).toMatchObject({ logState: "empty", lastSeq: 0, lastTurnOutcome: null }); expect(global.diagnostics).toHaveLength(1);
    expect(await readFile(active.path, "utf8")).toBe(active.content); expect(await readFile(empty.path, "utf8")).toBe(empty.content);
    expect(ctx.write).not.toHaveBeenCalled(); expect(ctx.mkdir).not.toHaveBeenCalled(); expect(ctx.acquire).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual(["sessions"]);
  });
  it("header-only 缺 LF 仍默认隐藏，all 保留真实尾部状态不修改", async () => {
    const item = await file("empty-tail", { empty: true }); await writeFile(item.path, item.content.trimEnd()); const ctx = store();
    expect(await ctx.adapter.list({ cwd, all: false })).toMatchObject({ entries: [], hiddenEmptyCount: 1 });
    expect((await ctx.adapter.list({ cwd, all: true })).entries[0]).toMatchObject({ turnCount: 0, logState: "missing_lf" });
    expect(await readFile(item.path, "utf8")).toBe(item.content.trimEnd());
  });
  it.each(["available", "busy", "unknown"] as const)("writerState=%s 与日志状态独立，不授予写许可", async (state) => {
    await file("id"); const ctx = store(state); const entry = (await ctx.adapter.list({ cwd, all: false })).entries[0]!;
    expect(entry).toMatchObject({ writerState: state, logState: "interrupted", resumability: state === "busy" ? "no" : state === "unknown" ? "check_on_open" : "yes" });
    expect([...entry.preview].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).toBe(true); expect(entry).not.toHaveProperty("lastUserProfile");
  });
  it("全局其他 cwd 始终不可选，哪怕 writer 可用", async () => {
    await file("other", { cwd: "/other" }); const ctx = store();
    expect((await ctx.adapter.list({ cwd, all: true })).entries[0]).toMatchObject({ resumability: "no", cwd: "/other" });
  });
  it("按活动、创建时间降序/ID升序排序，正确处理无小数秒与长小数精度", async () => {
    await file("z", { createdAt: "2026-10-29T12:00:00Z", activity: "2026-10-29T12:00:01Z" });
    await file("b", { activity: "2026-10-29T12:00:01.0001Z" }); await file("a", { activity: "2026-10-29T12:00:01.0001Z" });
    expect((await store().adapter.list({ cwd, all: false })).entries.map((e) => e.sessionId)).toEqual(["a", "b", "z"]);
  });
  it.each(["incomplete", "missing_lf"])("%s 尾部只观察不修复，原始字节不变", async (kind) => {
    const item = await file("tail", { tail: kind === "incomplete" ? '{"seq":2' : "" });
    if (kind === "missing_lf") await writeFile(item.path, item.content.trimEnd());
    const before = await readFile(item.path); const result = await store().adapter.list({ cwd, all: false });
    expect(result.entries[0]!.logState).toBe(kind === "incomplete" ? "torn_tail" : "missing_lf"); expect(await readFile(item.path)).toEqual(before);
    expect(await readdir(root)).toEqual(["sessions"]);
  });
  it("坏正文诊断带合法归属，坏 header/unsupported 不伪造条目时间或排序", async () => {
    await file("good"); await file("corrupt", { tail: "invalid\n" }); const future = await file("future");
    await writeFile(future.path, future.content.replace('"formatVersion":1', '"formatVersion":2'));
    const bad = await file("bad"); await writeFile(bad.path, "invalid\n");
    const result = await store().adapter.list({ cwd, all: true }); expect(result.entries).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.code).sort()).toEqual(["corrupt", "corrupt", "unsupported"]); expect(result.unattributedCount).toBe(2);
    expect(result.diagnostics.find((d) => d.sessionId === "corrupt")).toMatchObject({ cwd });
    expect(result.diagnostics.every((d) => !("lastActivityAt" in d))).toBe(true);
  });
  it("探测期间发生文件增长，标记 changing/check_on_open，不能当成原子快照", async () => {
    const item = await file("growing"); const ctx = store("available");
    ctx.locks.probe.mockImplementationOnce(async () => { await appendFile(item.path, '{"seq":2'); return "available"; });
    expect((await ctx.adapter.list({ cwd, all: false })).entries[0]).toMatchObject({ changing: true, resumability: "check_on_open" });
  });
  it("真实 T2 probe 观察本进程 busy，不创建新的 sidecar", async () => {
    const native = new SessionFileAdapter({ storageRoot: root }); stores.push(native); const opened = await native.create(cwd);
    await opened.writer.appendDurable({ type: "user", turnId: "turn", runtimeProfile: { provider: "test", model: "test" }, message: { role: "user", content: "q" } });
    const before = await readdir(join(root, "locks")); const observer = new SessionFileAdapter({ storageRoot: root }); stores.push(observer);
    expect((await observer.list({ cwd, all: false })).entries[0]).toMatchObject({ writerState: "busy", resumability: "no" }); expect(await readdir(join(root, "locks"))).toEqual(before);
  });
  it("目录读取失败是整体存储故障，而非成功的局部列表", async () => {
    await file("id"); const ctx = store("available", { io: { readdir: async () => { throw new Error("RAW PATH"); } } });
    await expect(ctx.adapter.list({ cwd, all: false })).rejects.toMatchObject({ code: "ownership_lost", operation: "list" });
  });
  it.each(["relative", "/does-not-exist"])("非法 cwd=%s 拒绝且不创建目录", async (value) => {
    await expect(store().adapter.list({ cwd: value, all: false })).rejects.toMatchObject({ code: "cwd_mismatch" }); expect(await readdir(cwd)).toEqual([]);
  });
  it("单文件 symlink/宽权限产生独立诊断，其他合法条目仍返回", async () => {
    const good = await file("good"); const wide = await file("wide"); await chmod(wide.path, 0o644);
    const link = await file("link"); await rm(link.path); await symlink(good.path, link.path);
    const ctx = store(); const list = await ctx.adapter.list({ cwd, all: true });
    expect(list.entries.map((item) => item.sessionId)).toEqual(["good"]); expect(list.diagnostics).toHaveLength(2);
    expect(ctx.acquire).not.toHaveBeenCalled(); expect(await readFile(good.path, "utf8")).toBe(good.content);
  });
  it("扫描 fd close 确认失败不得交付列表，真实整体清理保留故障", async () => {
    await file("id"); const ctx = store("available", { io: { close: async (handle) => { await nodeSessionFileIO.close(handle); throw new Error("late close failure"); } } });
    await expect(ctx.adapter.list({ cwd, all: false })).rejects.toMatchObject({ code: "close_failed", operation: "list_cleanup" });
    await expect(ctx.adapter.closeSettled()).rejects.toMatchObject({ code: "close_failed" });
  });
  it("probe 清理故障不得降级为 unknown/单文件诊断或伪装已安全关闭", async () => {
    await file("id"); const ctx = store(); const cause = new PersistenceError("close_failed", "probe_cleanup", "safe");
    ctx.locks.probe.mockRejectedValue(cause);
    await expect(ctx.adapter.list({ cwd, all: false })).rejects.toBe(cause); await expect(ctx.adapter.closeSettled()).rejects.toBe(cause);
  });
  it("list 超时不提前关扫描 fd，整体收尾等真实 read settle，并观察迟到失败", async () => {
    await file("id"); const clock = new TestClock(); const entered = deferred(); const gate = deferred();
    const handles: FileHandle[] = []; const close = vi.fn(nodeSessionFileIO.close);
    const ctx = store("available", { clock, io: { open: async (...args) => { const h = await nodeSessionFileIO.open(...args); handles.push(h); return h; }, read: async () => { entered.resolve(); await gate.promise; throw new Error("late"); }, close } });
    const observing = ctx.adapter.list({ cwd, all: false }).catch((error: unknown) => error);
    await entered.promise; clock.advance(30_000); expect(await observing).toMatchObject({ code: "io_timeout", operation: "list" });
    let finished = false; const closing = ctx.adapter.closeSettled().then(() => { finished = true; }); await flush(); expect(finished).toBe(false); expect(close).not.toHaveBeenCalled();
    gate.resolve(); await closing; expect(close).toHaveBeenCalledOnce(); expect(handles).toHaveLength(1);
  });
});
