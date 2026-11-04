import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LineInput } from "../src/bootstrap/lineInput.js";
import { pickSession, printSessionList } from "../src/bootstrap/sessionPicker.js";
import { PersistenceError, SessionAccessError, type SessionAccessCode } from "../src/contracts/session.js";
import { deferred, flush } from "./persistenceHelpers.js";
import { QueueInput, entry, fakeStore, listing } from "./sessionUiHelpers.js";

function picker(lines: string[], entries = [entry()]) {
  const store = fakeStore(listing(entries)); const input = new QueueInput(lines);
  const write = vi.fn(); const error = vi.fn(); const select = vi.fn(async () => true);
  return { store, input, write, error, select, cwd: "/repo", all: false };
}

describe("共享 picker 快照、访问拒绝与取消", () => {
  it.each(["q", "", "   "])("%j 取消不选默认项、不读下一问题", async (answer) => {
    const options = picker([answer, "next question"]);
    expect(await pickSession(options)).toBe("cancelled");
    expect(options.select).not.toHaveBeenCalled(); expect(options.input.consumed).toBe(1);
  });
  it("非法/越界/命令只提示，编号仍映射原快照 ID", async () => {
    const options = picker(["x", "0", "2", "1.0", "/new", "1", "question"]);
    expect(await pickSession(options)).toBe("selected");
    expect(options.select).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "candidate" }), expect.any(AbortSignal));
    expect(options.error).toHaveBeenCalledTimes(5); expect(options.input.consumed).toBe(6);
    expect(options.write.mock.calls.flat().join("")).not.toContain("candidate");
  });
  it("只有 a/r 重建排序和编号，空视图仍能切换/刷新/取消", async () => {
    const options = picker(["a", "r", "q"], []);
    await pickSession(options);
    expect(options.store.list).toHaveBeenNthCalledWith(1, { cwd: "/repo", all: false });
    expect(options.store.list).toHaveBeenNthCalledWith(2, { cwd: "/repo", all: true });
    expect(options.store.list).toHaveBeenNthCalledWith(3, { cwd: "/repo", all: true });
    expect(options.write.mock.calls.flat().join("")).not.toContain("1)");
  });
  it.each(["session_busy", "not_found", "cwd_mismatch", "corrupt", "unsupported", "invalid_identity", "permission_denied"] satisfies SessionAccessCode[])("访问拒绝 %s 保持编号快照，不自动重新 list", async (code) => {
    const options = picker(["1", "1", "q"]);
    options.select.mockRejectedValue(new SessionAccessError(code, "open_write", "private /path"));
    expect(await pickSession(options)).toBe("cancelled");
    expect(options.store.list).toHaveBeenCalledTimes(1); expect(options.select).toHaveBeenCalledTimes(2);
    expect(options.error.mock.calls.flat().join("")).not.toContain("private");
  });
  it.each(["lock_unavailable", "platform_unsupported"] satisfies SessionAccessCode[])("%s 不是可重试访问拒绝", async (code) => {
    const options = picker(["1", "q"]); const cause = new SessionAccessError(code, "open", "private");
    options.select.mockRejectedValue(cause); await expect(pickSession(options)).rejects.toBe(cause);
    expect(options.input.consumed).toBe(1);
  });
  it("PersistenceError 原样穿透，不留在 picker 重试", async () => {
    const options = picker(["1", "q"]); const cause = new PersistenceError("repair_failed", "open", "private");
    options.select.mockRejectedValue(cause); await expect(pickSession(options)).rejects.toBe(cause);
  });
  it.each([
    { writerState: "busy" as const, resumability: "no" as const }, { cwd: "/other", resumability: "no" as const },
    { logState: "corrupt" as const, resumability: "no" as const }, { logState: "unsupported" as const, resumability: "no" as const },
  ])("不可选条目 %j 只提示", async (overrides) => {
    const options = picker(["1", "q"], [entry("x", overrides)]);
    await pickSession(options); expect(options.select).not.toHaveBeenCalled(); expect(options.error).toHaveBeenCalledOnce();
  });
  it.each([{ writerState: "unknown" as const }, { changing: true }])("unknown/changing %j 允许正式打开", async (overrides) => {
    const options = picker(["1"], [entry("x", { ...overrides, resumability: "check_on_open" })]);
    expect(await pickSession(options)).toBe("selected"); expect(options.select).toHaveBeenCalledOnce();
  });
  it("当前会话显示标记且不重新打开", async () => {
    const options = picker(["1"], [entry("current", { writerState: "busy", resumability: "no" })]);
    expect(await pickSession({ ...options, currentSessionId: "current" })).toBe("selected");
    expect(options.select).not.toHaveBeenCalled(); expect(options.write.mock.calls.flat().join("")).toContain("当前会话");
  });
  it.each(["interrupt", "eof"])("人工等待 %s 立即结束选择，不消费新问题", async (kind) => {
    const options = picker([]); const task = pickSession(options); await flush();
    if (kind === "interrupt") options.input.interrupt(); else options.input.end();
    expect(await task).toBe(kind === "interrupt" ? "interrupted" : "eof");
  });
  it.each(["list", "open"])("%s 期间 Ctrl+C 等待真实 I/O 和候选关闭", async (operation) => {
    const options = picker(["1", "next"]); const held = deferred(); let settled = false;
    if (operation === "list") vi.mocked(options.store.list).mockImplementation(async () => { await held.promise; settled = true; return listing([entry()]); });
    else options.select.mockImplementation(async () => { await held.promise; settled = true; return false; });
    const task = pickSession(options); let finished = false; void task.then(() => { finished = true; }); await flush();
    options.input.interrupt(); await flush(); expect(finished).toBe(false);
    held.resolve(); expect(await task).toBe("interrupted"); expect(settled).toBe(true);
    expect(options.input.consumed).toBe(operation === "list" ? 0 : 1);
  });
  it("list/open 等待中 EOF 也等待实际 settle，不消费下一行", async () => {
    for (const operation of ["list", "open"]) {
      const options = picker(["1", "next"]); const entered = deferred(); const held = deferred();
      if (operation === "list") vi.mocked(options.store.list).mockImplementation(async () => { entered.resolve(); await held.promise; return listing([entry()]); });
      else options.select.mockImplementation(async () => { entered.resolve(); await held.promise; return false; });
      const task = pickSession(options); await entered.promise; options.input.end(); held.resolve();
      expect(await task).toBe("eof"); expect(options.input.consumed).toBe(operation === "list" ? 0 : 1);
    }
  });
  it("显式 sessions 才显示完整 ID；诊断移除终端控制字符", () => {
    const write = vi.fn(); printSessionList({ ...listing([entry("full-id", { preview: "x\u001b[31m\nprivate" })]), diagnostics: [{ sourceBasename: "bad", code: "corrupt", message: "安全" }] }, true, write);
    const text = write.mock.calls.flat().join(""); expect(text).toContain("full-id"); expect(text).not.toContain("\u001b"); expect(text).toContain("诊断 bad");
  });
});

describe("唯一行输入队列", () => {
  function source() { const stdin = new PassThrough(); const stdout = new PassThrough(); const signals = new EventEmitter(); const input = new LineInput(stdin, stdout, signals); return { stdin, stdout, signals, input }; }
  it("预送问题按序交付，EOF 前队列保留；没有第二个 readline", async () => {
    const ctx = source(); ctx.stdin.end("one\ntwo\n"); await new Promise((resolve) => setImmediate(resolve));
    expect(await ctx.input.read("")).toEqual({ type: "line", text: "one" }); expect(await ctx.input.read("")).toEqual({ type: "line", text: "two" });
    expect(await ctx.input.read("")).toEqual({ type: "eof" }); ctx.input.dispose(); expect(ctx.signals.listenerCount("SIGINT")).toBe(0);
  });
  it("stop 丢弃预送问题，挂起读者得到 EOF", async () => {
    const ctx = source(); ctx.stdin.write("one\ntwo\n"); ctx.input.stop();
    expect(await ctx.input.read("")).toEqual({ type: "eof" }); ctx.input.dispose();
  });
  it("执行期 SIGINT 只通知业务，闲置期唤醒读取，不残留取消事件", async () => {
    const ctx = source(); const abort = vi.fn(); ctx.input.onInterrupt(abort); ctx.signals.emit("SIGINT");
    const read = ctx.input.read(""); ctx.stdin.write("next\n"); expect(await read).toEqual({ type: "line", text: "next" });
    const waiting = ctx.input.read(""); ctx.signals.emit("SIGINT"); expect(await waiting).toEqual({ type: "interrupt" });
    expect(abort).toHaveBeenCalledTimes(2); ctx.input.dispose();
  });
});
