import { mkdtemp, realpath, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { nodeSessionFileIO, type SessionFileIO } from "../src/adapters/session/sessionFileIO.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { ReadFileTool } from "../src/adapters/filesystem/ReadFileTool.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { runSessionApp } from "../src/bootstrap/sessionApp.js";
import { profileNotice } from "../src/bootstrap/repl.js";
import { scanSessionFile } from "../src/adapters/session/scanSession.js";
import type { SessionSnapshot, TurnFact } from "../src/contracts/session.js";
import { PersistenceError, SessionAccessError } from "../src/contracts/session.js";
import { QueueInput } from "./sessionUiHelpers.js";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, toolCompletion } from "./helpers.js";
import { deferred } from "./persistenceHelpers.js";

let cwd: string; let root: string; let requests: { messages: { role: string; content?: string }[] }[];
let server: Awaited<ReturnType<typeof startServer>>;
const stores: SessionFileAdapter[] = [];
const profile = { provider: "opencode-go", model: "test-model" };
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "yucli-t8-repl-"))); root = join(cwd, ".yucli"); requests = [];
  await writeFile(join(cwd, "README.md"), "tool text");
  server = await startServer(async (req, res) => {
    const body = await readJson(req) as typeof requests[number]; requests.push(body);
    const prompt = body.messages.findLast((item) => item.role === "user")?.content;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (prompt === "fail") res.end(sseFrame(streamChunk({ content: "partial" })));
    else if (prompt === "hang") res.write(sseFrame(streamChunk({ content: "partial" })));
    else if (prompt === "read" && body.messages.at(-1)?.role === "user") res.end(completionSse(toolCompletion()));
    else res.end(completionSse(completion("ok")));
  });
});
afterEach(async () => { for (const store of stores.splice(0)) await store.closeSettled().catch(() => {}); await server.close(); await rm(cwd, { recursive: true, force: true }); });
function adapter(io: Partial<SessionFileIO> = {}) { const store = new SessionFileAdapter({ storageRoot: root, io }); stores.push(store); return store; }
function app(lines: string[] = [], store = adapter()) {
  const input = new QueueInput(lines); const write = vi.fn(); const error = vi.fn();
  const runtime = vi.fn(() => ({ client: new OpenCodeGoClient({ apiKey: "local-test-key", baseUrl: server.baseUrl, timeoutMs: 500 }), registry: new RegisteredTools([new ReadFileTool(cwd)]), model: profile.model, profile }));
  return { store, cwd, input: () => input, source: input, runtime, preflight: () => new SessionLockAdapter({ storageRoot: root }).preflight(), write, error, exit: vi.fn() };
}
async function files() { return (await readdir(join(root, "sessions"))).filter((name) => name.endsWith(".jsonl")).map((name) => join(root, "sessions", name)); }
async function seed(options: { incomplete?: boolean; missingLf?: boolean; oldProfile?: typeof profile } = {}) {
  const store = adapter(); const item = await store.create(cwd); const id = item.snapshot.meta.sessionId;
  const facts: TurnFact[] = [
    { type: "user", turnId: "old-success", message: { role: "user", content: "old question" }, runtimeProfile: options.oldProfile ?? profile },
    { type: "assistant", turnId: "old-success", assistantId: "a1", message: { role: "assistant", content: "old answer" } },
    { type: "turn_end", turnId: "old-success", end: { outcome: "success" } },
    { type: "user", turnId: "old-failed", message: { role: "user", content: "failed question" }, runtimeProfile: profile },
    { type: "turn_end", turnId: "old-failed", end: { outcome: "failed", error: { category: "internal", code: "internal_error", message: "安全错误" } } },
    { type: "user", turnId: "old-interrupted", message: { role: "user", content: "interrupted question" }, runtimeProfile: profile },
  ];
  for (const fact of facts) await item.writer.appendDurable(fact);
  await store.close(); const path = (await files())[0]!; const bytes = await readFile(path);
  if (options.incomplete) await writeFile(path, Buffer.concat([bytes, Buffer.from('{"seq":7')]));
  if (options.missingLf) await writeFile(path, bytes.subarray(0, -1));
  return { id, path };
}

describe("持久化 REPL + 真实 T5/T7 store + 本地 SSE", () => {
  it("帮助/空行/非法命令/new/clear 不创建会话，不发模型请求", async () => {
    const ctx = app(["", "/help", "/new", "/clear", "/new extra", "/resume ../bad", "/resume id extra", "/exit"]);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]); expect(requests).toHaveLength(0);
  });
  it("首个普通问题才 create，两轮共用文件/锁且 seq 连续，只提交完整历史", async () => {
    const ctx = app(["first", "second", "/exit"]); const create = vi.spyOn(ctx.store, "create");
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(create).toHaveBeenCalledOnce();
    const paths = await files(); expect(paths).toHaveLength(1);
    const scan = await scanSessionFile(paths[0]!); expect(scan).toMatchObject({ status: "valid", lastSeq: 6, tailKind: "none", statistics: { turnCount: 2 } });
    expect(requests[1]?.messages).toEqual([{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" }]);
    const observer = adapter(); const restored = await observer.openWrite({ sessionId: scan.status === "valid" ? scan.meta.sessionId : "", cwd });
    expect(restored.snapshot.recentSuccessfulTurns).toHaveLength(2); await observer.close();
  });
  it("new/clear 都关闭旧 writer，清空上下文，旧文件保留", async () => {
    const ctx = app(["first", "/new", "second", "/clear", "third", "/exit"]);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(await files()).toHaveLength(3);
    expect(requests.every((request) => request.messages.length === 1)).toBe(true);
  });
  it.each(["fail", "hang"])("%s 保存非成功终止后继续；失败不进入后续历史", async (prompt) => {
    const ctx = app(["good", prompt, "next", "/exit"]);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0);
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "good" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }]);
    const rows = (await readFile((await files())[0]!, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.type === "turn_end").map((row) => row.payload.outcome)).toEqual(["success", prompt === "hang" ? "timeout" : "failed", "success"]);
  });
  it("非 TTY /resume 不消费下一问题；其他未知斜杠仍为普通问题", async () => {
    const ctx = app(["/resume", "/resume --all", "/unknown", "/exit"]); ctx.source.tty = false;
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(requests).toHaveLength(1); expect(requests[0]?.messages[0]?.content).toBe("/unknown");
  });
  it.each(["none", "missing_lf", "incomplete"])("直接恢复 %s 只投影成功组，不重放旧工具/请求；新 seq/turnId", async (tail) => {
    const old = await seed({ missingLf: tail === "missing_lf", incomplete: tail === "incomplete" });
    const ctx = app(["new", "/exit"]); expect(await runSessionApp({ type: "resume", id: old.id, all: false }, ctx)).toBe(0);
    expect(requests).toHaveLength(1); expect(requests[0]?.messages).toEqual([{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }, { role: "user", content: "new" }]);
    const scan = await scanSessionFile(old.path); expect(scan).toMatchObject({ status: "valid", tailKind: "none", lastSeq: 9 });
    if (scan.status === "valid") expect(scan.recentSuccessfulTurns.at(-1)?.turnId).not.toMatch(/^old-/u);
    expect(ctx.error.mock.calls.flat().join("")).toContain(tail === "none" ? "尾部 none" : tail === "missing_lf" ? "append_lf" : "truncate_tail");
  });
  it("REPL 准备候选成功才关闭旧会话并替换历史，当前配置只加载一次", async () => {
    const old = await seed(); const ctx = app(["fresh", `/resume ${old.id}`, "next", "/exit"]);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(ctx.runtime).toHaveBeenCalledOnce();
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "old question" }, { role: "assistant", content: "old answer" }, { role: "user", content: "next" }]);
  });
  it("REPL 直接访问拒绝保留健康会话与历史，可以重试", async () => {
    const ctx = app(["good", "/resume missing", "next", "/exit"]);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(await files()).toHaveLength(1);
    expect(requests.at(-1)?.messages[0]?.content).toBe("good"); expect(ctx.error.mock.calls.flat().join("")).toContain("not_found");
  });
  it("picker 选择当前会话不重新打开，q/非法选择保留旧历史", async () => {
    const ctx = app(["good", "/resume", "/new", "1", "/resume", "q", "next", "/exit"]); const open = vi.spyOn(ctx.store, "openWrite");
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(0); expect(open).not.toHaveBeenCalled();
    expect(requests.at(-1)?.messages[0]?.content).toBe("good"); expect(ctx.write.mock.calls.flat().join("")).toContain("当前会话");
  });
  it("REPL picker 访问拒绝保留原快照/旧锁，Ctrl+C 只取消选择", async () => {
    const old = await seed(); const ctx = app(["good", "/resume", "2"]); const entered = deferred(); const gate = deferred();
    const open = vi.spyOn(ctx.store, "openWrite").mockImplementation(async () => { entered.resolve(); await gate.promise; throw new SessionAccessError("not_found", "open", "private"); });
    const running = runSessionApp({ type: "repl" }, ctx); await entered.promise; ctx.source.interrupt(); gate.resolve();
    await vi.waitFor(() => expect(ctx.source.prompts.at(-1)).toBe("yucli> "));
    ctx.source.line("next"); ctx.source.line("/exit"); expect(await running).toBe(0); expect(open).toHaveBeenCalledWith({ sessionId: old.id, cwd });
    expect(requests.at(-1)?.messages[0]?.content).toBe("good");
  });
  it("准备候选中取消：等待已持锁 open settle 后关闭候选，旧会话和历史仍可用", async () => {
    const old = await seed(); const ctx = app(["good", `/resume ${old.id}`]); const acquired = deferred(); const gate = deferred();
    const original = ctx.store.openWrite.bind(ctx.store);
    vi.spyOn(ctx.store, "openWrite").mockImplementation(async (query) => { const candidate = await original(query); acquired.resolve(); await gate.promise; return candidate; });
    const running = runSessionApp({ type: "repl" }, ctx); await acquired.promise; const locks = new SessionLockAdapter({ storageRoot: root });
    expect(await locks.probe(old.id)).toBe("busy"); ctx.source.interrupt(); expect(await locks.probe(old.id)).toBe("busy");
    gate.resolve(); await vi.waitFor(() => expect(ctx.source.consumed).toBe(3));
    expect(await locks.probe(old.id)).toBe("available"); ctx.source.line("next"); ctx.source.line("/exit");
    expect(await running).toBe(0); expect(requests.at(-1)?.messages[0]?.content).toBe("good");
  });
  it("REPL picker EOF 请求关闭整个 REPL；普通闲置 Ctrl+C 返回 130", async () => {
    for (const command of ["/resume", ""]) {
      const ctx = app(command ? [command] : []); const running = runSessionApp({ type: "repl" }, ctx);
      await vi.waitFor(() => expect(ctx.source.prompts).not.toHaveLength(0));
      if (command) { ctx.source.end(); expect(await running).toBe(0); }
      else { ctx.source.interrupt(); expect(await running).toBe(130); }
      expect(requests).toHaveLength(0);
    }
  });
  it("旧 close 开始后迟到取消不撤销已固定切换", async () => {
    const old = await seed(); const ctx = app(["good", `/resume ${old.id}`]); const entered = deferred(); const gate = deferred();
    const originalCreate = ctx.store.create.bind(ctx.store);
    vi.spyOn(ctx.store, "create").mockImplementation(async (path) => {
      const item = await originalCreate(path);
      return { ...item, writer: { appendDurable: item.writer.appendDurable.bind(item.writer), close: async () => { entered.resolve(); await gate.promise; await item.writer.close(); } } };
    });
    const running = runSessionApp({ type: "repl" }, ctx); await entered.promise; ctx.source.interrupt(); gate.resolve();
    await vi.waitFor(() => expect(ctx.source.consumed).toBe(3)); ctx.source.line("next"); ctx.source.line("/exit");
    expect(await running).toBe(0); expect(requests.at(-1)?.messages[0]?.content).toBe("old question");
  });
  it("切换时旧 close 失败不交付候选历史，停止后续输入并关闭两者", async () => {
    const old = await seed(); const ctx = app(["good", `/resume ${old.id}`, "never"]); const originalCreate = ctx.store.create.bind(ctx.store);
    vi.spyOn(ctx.store, "create").mockImplementation(async (path) => { const item = await originalCreate(path); return { ...item, writer: { appendDurable: item.writer.appendDurable.bind(item.writer), close: async () => { throw new PersistenceError("close_failed", "close", "safe"); } } }; });
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(requests).toHaveLength(1); expect(ctx.source.consumed).toBe(2);
    expect(await new SessionLockAdapter({ storageRoot: root }).probe(old.id)).toBe("available");
  });
  it("profile 不一致只在首次新请求前提示一次；提示不进模型消息", async () => {
    const old = await seed({ oldProfile: { provider: "other", model: "old-model" } }); const ctx = app(["first", "second", "/exit"]);
    expect(await runSessionApp({ type: "resume", id: old.id, all: false }, ctx)).toBe(0);
    const errors = ctx.error.mock.calls.flat().join(""); expect(errors.split("恢复历史使用")).toHaveLength(2); expect(errors).toContain("other/old-model");
    expect(JSON.stringify(requests)).not.toMatch(/provider|old-model|runtimeProfile/u);
  });
  it("CommittedTurnResult 未确认前不接受下一问题；终止确认期间迟到取消仍提交已固定成功", async () => {
    const entered = deferred(); const gate = deferred(); let stage = ""; let once = false;
    const store = adapter({
      write: async (handle, bytes, position) => { stage = (JSON.parse(Buffer.from(bytes).toString()) as { type: string }).type; return nodeSessionFileIO.write(handle, bytes, position); },
      sync: async (handle) => { if (stage === "turn_end" && !once) { once = true; entered.resolve(); await gate.promise; } await nodeSessionFileIO.sync(handle); },
    });
    const ctx = app(["first", "second", "/exit"], store); const task = runSessionApp({ type: "repl" }, ctx); await entered.promise;
    expect(ctx.source.consumed).toBe(1); expect(requests).toHaveLength(1);
    ctx.source.interrupt(); // success 已固定，不能因终止保存期间 Ctrl+C 丢掉成功凭证或写第二个 end。
    gate.resolve(); expect(await task).toBe(0); expect(requests[1]?.messages).toHaveLength(3);
    const scan = await scanSessionFile((await files())[0]!);
    expect(scan.status === "valid" ? scan.turns.map((turn) => turn.outcome) : []).toEqual(["success", "success"]);
  });
  it.each(["user", "assistant", "tool_result", "turn_end"])("%s 保存失败 D07：停止管道预送问题/模型请求，真实文件前缀可分析", async (target) => {
    const store = adapter({ write: async (handle, bytes, position) => {
      const row = JSON.parse(Buffer.from(bytes).toString()) as { type: string; payload?: { role?: string } };
      const stage = row.type === "message" ? row.payload!.role : row.type;
      if (stage === target) throw new Error("PRIVATE IO PATH");
      return nodeSessionFileIO.write(handle, bytes, position);
    } });
    const ctx = app([target === "tool_result" ? "read" : "first", "must-not-execute", "/exit"], store);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(ctx.source.consumed).toBe(1);
    expect(requests).toHaveLength(target === "user" ? 0 : 1); expect(ctx.error.mock.calls.flat().join("")).not.toContain("PRIVATE");
    expect(await scanSessionFile((await files())[0]!)).toMatchObject({ status: "valid", tailKind: "none" });
    expect((await new SessionLockAdapter({ storageRoot: root }).probe(basename((await files())[0]!).split("_")[1]!.slice(0, -6)))).toBe("available");
  });
  it("create 拒绝不消费后续输入、不请求模型", async () => {
    const ctx = app(["first", "second"]); vi.spyOn(ctx.store, "create").mockRejectedValue(new SessionAccessError("permission_denied", "create", "private"));
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(ctx.source.consumed).toBe(1); expect(requests).toHaveLength(0);
  });
  it("候选修复备份失败退出 5，不继续旧/新问题；旧正文不变", async () => {
    const old = await seed({ incomplete: true }); const before = await readFile(old.path); let backup = false;
    const store = adapter({ open: async (path, flags, mode) => { if (path.endsWith(".bak")) backup = true; return nodeSessionFileIO.open(path, flags, mode); },
      write: async (handle, bytes, position) => { if (backup) throw new Error("backup failed"); return nodeSessionFileIO.write(handle, bytes, position); } });
    const ctx = app([`/resume ${old.id}`, "never"], store); expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5);
    expect(ctx.source.consumed).toBe(1); expect(requests).toHaveLength(0); expect(await readFile(old.path)).toEqual(before);
  });
  it("new 的旧 writer close 失败退出 5，不进入新会话；监督关闭真实资源", async () => {
    const ctx = app(["first", "/new", "never"]); const create = ctx.store.create.bind(ctx.store);
    vi.spyOn(ctx.store, "create").mockImplementation(async (path) => { const item = await create(path); return { ...item, writer: { appendDurable: item.writer.appendDurable.bind(item.writer), close: async () => { throw new PersistenceError("close_failed", "close", "private"); } } }; });
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(ctx.source.consumed).toBe(2); expect(requests).toHaveLength(1); expect(await files()).toHaveLength(1);
  });
  it("profile 只比较最近成功 turn，较早配置不同但最近配置相同时不提示", () => {
    const snapshot: SessionSnapshot = {
      meta: { sessionId: "id", cwd, createdAt: "2026-10-29T00:00:00Z" },
      recentSuccessfulTurns: [
        { turnId: "older-success", runtimeProfile: { provider: "other", model: "old-model" }, items: [] },
        { turnId: "latest-success", runtimeProfile: profile, items: [] },
      ],
      lastUserProfile: { provider: "other", model: "newer-failed-turn-model" },
      interruptedTurnCount: 0,
      repair: "none",
    };
    expect(profileNotice(snapshot, profile)).toBe("");
  });
  it("profile 缺摘要提示不能完整核对；无成功组回退最近 user", () => {
    const base: SessionSnapshot = { meta: { sessionId: "id", cwd, createdAt: "2026-10-29T00:00:00Z" }, recentSuccessfulTurns: [], interruptedTurnCount: 0, repair: "none" };
    expect(profileNotice(base, profile)).toContain("缺少运行摘要");
    expect(profileNotice({
      ...base,
      recentSuccessfulTurns: [{ turnId: "latest-without-profile", items: [] }],
      lastUserProfile: profile,
    }, profile)).toContain("缺少运行摘要");
    expect(profileNotice({ ...base, lastUserProfile: profile }, profile)).toBe("");
    expect(profileNotice({ ...base, lastUserProfile: { provider: "old", model: "old" } }, profile)).toContain("old/old");
  });
});
