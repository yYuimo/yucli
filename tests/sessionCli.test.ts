import { describe, expect, it, vi } from "vitest";
import { cliCommand, cliMode } from "../src/bootstrap/cliOptions.js";
import { runSessionApp } from "../src/bootstrap/sessionApp.js";
import { ConfigError } from "../src/contracts/llm-client.js";
import { PersistenceError, SessionAccessError, type SessionAccessCode } from "../src/contracts/session.js";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { QueueInput, entry, fakeStore, listing, opened } from "./sessionUiHelpers.js";
import { TestClock, deferred, flush } from "./persistenceHelpers.js";
import { reportError } from "../src/bootstrap/output.js";
import { ToolExecutionError } from "../src/contracts/tool.js";

function parse(args: string[]) { return cliMode(cliCommand().parse(args, { from: "user" })); }
function app(lines: string[] = [], entries = [entry()]) {
  const input = new QueueInput(lines); const store = fakeStore(listing(entries)); const write = vi.fn(); const error = vi.fn();
  const runtime = vi.fn(() => ({ client: new OpenCodeGoClient({ apiKey: "unused", baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 10 }),
    registry: new RegisteredTools([]), model: "test", profile: { provider: "local", model: "test" } }));
  return { store, cwd: "/repo", input: () => input, source: input, runtime, preflight: vi.fn(async () => {}), write, error, exit: vi.fn() };
}

describe("T8 CLI 参数在副作用前分流", () => {
  it.each([
    [[], { type: "repl" }], [["--prompt", "hello"], { type: "prompt", prompt: "hello" }],
    [["--sessions"], { type: "sessions", all: false }], [["--sessions", "--all"], { type: "sessions", all: true }],
    [["--resume"], { type: "resume", all: false }], [["-r", "--all"], { type: "resume", all: true }],
    [["-r", "full_ID-123"], { type: "resume", all: false, id: "full_ID-123" }], [["-c"], { type: "continue" }],
  ])("合法参数 %j", (args, mode) => { expect(parse(args as string[])).toEqual(mode); });
  it.each([
    ["--prompt", "hi", "--sessions"], ["--prompt", "hi", "--resume"], ["--prompt", "hi", "-c"],
    ["--sessions", "--resume"], ["--sessions", "-c"], ["--resume", "-c"],
    ["--all"], ["--all", "-c"], ["--all", "--resume", "id"], ["--all", "--prompt", "hi"],
    ["--continue", "id"], ["--resume", "id", "extra"], ["--resume", ""], ["--resume", " "],
    ["--resume", "../unsafe"], ["--resume", "a/b"], ["--resume", "a".repeat(129)], ["--prompt", " "],
  ])("非法参数 %j", (...args: string[]) => { expect(() => parse(args)).toThrow(); });
});

describe("启动列表、恢复、配置顺序及安全退出", () => {
  it("列表不加载配置/不创建输入，含诊断仍返回 0", async () => {
    const ctx = app(); vi.mocked(ctx.store.list).mockResolvedValue({ ...listing([entry("copy-full-id")]), diagnostics: [{ sourceBasename: "bad", code: "corrupt", message: "safe" }] });
    const createInput = vi.spyOn(ctx, "input"); expect(await runSessionApp({ type: "sessions", all: true }, ctx)).toBe(0);
    expect(ctx.runtime).not.toHaveBeenCalled(); expect(createInput).not.toHaveBeenCalled(); expect(ctx.preflight).not.toHaveBeenCalled();
    expect(ctx.write.mock.calls.flat().join("")).toContain("copy-full-id"); expect(ctx.store.openWrite).not.toHaveBeenCalled();
  });
  it.each(["q", ""])("启动 picker %j 不要求配置且不打开会话", async (line) => {
    const ctx = app([line]); expect(await runSessionApp({ type: "resume", all: false }, ctx)).toBe(0);
    expect(ctx.runtime).not.toHaveBeenCalled(); expect(ctx.store.openWrite).not.toHaveBeenCalled();
  });
  it("picker EOF=0、Ctrl+C=130", async () => {
    for (const kind of ["eof", "interrupt"]) {
      const ctx = app(); const task = runSessionApp({ type: "resume", all: false }, ctx); await flush();
      if (kind === "eof") ctx.source.end(); else ctx.source.interrupt();
      expect(await task).toBe(kind === "eof" ? 0 : 130); expect(ctx.runtime).not.toHaveBeenCalled();
    }
  });
  it.each(["direct", "picker", "continue"])("%s 配置失败为 3，早于写锁/修复", async (kind) => {
    const ctx = app(["1"]); ctx.runtime.mockImplementation(() => { throw new ConfigError("缺少配置"); });
    const mode = kind === "direct" ? { type: "resume" as const, id: "candidate", all: false } : kind === "picker" ? { type: "resume" as const, all: false } : { type: "continue" as const };
    expect(await runSessionApp(mode, ctx)).toBe(3); expect(ctx.store.openWrite).not.toHaveBeenCalled();
  });
  it("continue 无候选=5，不读配置、不新建", async () => {
    const ctx = app([], []); expect(await runSessionApp({ type: "continue" }, ctx)).toBe(5);
    expect(ctx.runtime).not.toHaveBeenCalled(); expect(ctx.store.create).not.toHaveBeenCalled();
  });
  it.each(["session_busy", "not_found", "corrupt", "unsupported", "cwd_mismatch"] satisfies SessionAccessCode[])("continue 最近候选 %s 不回退第二项", async (code) => {
    const ctx = app([], [entry("newest", { writerState: "busy", resumability: "no" }), entry("older")]);
    vi.mocked(ctx.store.openWrite).mockRejectedValue(new SessionAccessError(code, "open", "private"));
    expect(await runSessionApp({ type: "continue" }, ctx)).toBe(5);
    expect(ctx.store.openWrite).toHaveBeenCalledExactlyOnceWith({ sessionId: "newest", cwd: "/repo" }); expect(ctx.store.create).not.toHaveBeenCalled();
  });
  it.each([{ writerState: "unknown" as const }, { changing: true }])("continue %j 正式 openWrite 不跳过", async (overrides) => {
    const ctx = app(["/exit"], [entry("newest", overrides), entry("older")]);
    expect(await runSessionApp({ type: "continue" }, ctx)).toBe(0);
    expect(ctx.store.openWrite).toHaveBeenCalledWith({ sessionId: "newest", cwd: "/repo" });
  });
  it("continue 排除无 user 但有缺 LF 标记的空候选", async () => {
    const ctx = app(["/exit"], [entry("empty-tail", { turnCount: 0, logState: "missing_lf", lastSeq: 0 }), entry("nonempty")]);
    expect(await runSessionApp({ type: "continue" }, ctx)).toBe(0);
    expect(ctx.store.openWrite).toHaveBeenCalledExactlyOnceWith({ sessionId: "nonempty", cwd: "/repo" });
  });
  it("启动 picker 访问拒绝后原编号仍是同一 ID；配置只加载一次", async () => {
    const ctx = app(["1", "1", "/exit"]); vi.mocked(ctx.store.openWrite).mockRejectedValueOnce(new SessionAccessError("session_busy", "open", "private")).mockResolvedValue(opened());
    expect(await runSessionApp({ type: "resume", all: false }, ctx)).toBe(0);
    expect(ctx.store.list).toHaveBeenCalledOnce(); expect(ctx.store.openWrite).toHaveBeenCalledTimes(2); expect(ctx.runtime).toHaveBeenCalledOnce();
  });
  it("选后 Ctrl+C 等 open settle 并关闭候选，保留下一行不执行", async () => {
    const ctx = app(["1", "never ask"]); const entered = deferred(); const held = deferred(); const candidate = opened();
    vi.mocked(ctx.store.openWrite).mockImplementation(async () => { entered.resolve(); await held.promise; return candidate; });
    const task = runSessionApp({ type: "resume", all: false }, ctx); await entered.promise; ctx.source.interrupt(); await flush();
    expect(candidate.writer.close).not.toHaveBeenCalled(); held.resolve(); expect(await task).toBe(130);
    expect(candidate.writer.close).toHaveBeenCalledOnce(); expect(ctx.source.consumed).toBe(1);
  });
  it.each(["lock_unavailable", "platform_unsupported"] satisfies SessionAccessCode[])("picker %s 故障退出 5", async (code) => {
    const ctx = app(["1", "q"]); vi.mocked(ctx.store.openWrite).mockRejectedValue(new SessionAccessError(code, "open", "private"));
    expect(await runSessionApp({ type: "resume", all: false }, ctx)).toBe(5); expect(ctx.source.consumed).toBe(1);
  });
  it("存储故障立刻停输入，真实收尾后退出 5", async () => {
    const ctx = app(["first", "second"]); const cause = new PersistenceError("sync_failed", "create", "private");
    vi.mocked(ctx.store.create).mockRejectedValue(cause);
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(ctx.source.consumed).toBe(1);
    expect(ctx.store.closeSettled).toHaveBeenCalledOnce(); expect(ctx.store.close).not.toHaveBeenCalled(); expect(ctx.exit).not.toHaveBeenCalled();
    expect(ctx.error.mock.calls.flat().join("")).not.toContain("private");
  });
  it("收尾挂起只由注入 exit(5) 结束，5 秒期限不提前释放", async () => {
    const ctx = app(["first", "second"]); const clock = new TestClock(); const held = deferred();
    vi.mocked(ctx.store.create).mockRejectedValue(new PersistenceError("io_timeout", "create", "safe"));
    vi.mocked(ctx.store.closeSettled).mockReturnValue(held.promise);
    const task = runSessionApp({ type: "repl" }, { ...ctx, clock }); await flush();
    clock.advance(4999); expect(ctx.exit).not.toHaveBeenCalled(); clock.advance(1); expect(await task).toBe(5); expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(5);
    held.reject(new Error("late private rejection")); await flush();
  });
  it("正常 0/130 被关闭故障覆盖为 5", async () => {
    const ctx = app(["/exit"]); vi.mocked(ctx.store.close).mockRejectedValue(new PersistenceError("close_failed", "close", "private"));
    expect(await runSessionApp({ type: "repl" }, ctx)).toBe(5); expect(ctx.store.closeSettled).toHaveBeenCalledOnce();
  });
  it("安全输出将 ToolExecutionError 映射 4，存储错误映射 5", () => {
    const write = vi.fn(); expect(reportError(new ToolExecutionError(), write)).toBe(4);
    expect(reportError(new SessionAccessError("not_found", "open", "/private"), write)).toBe(5);
    expect(reportError(new Error("Authorization"), write)).toBe(1); expect(write.mock.calls.flat().join("")).not.toMatch(/private|Authorization/u);
  });
});
