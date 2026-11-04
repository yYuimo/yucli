import { describe, expect, it, vi } from "vitest";
import { PersistenceSupervisor } from "../src/bootstrap/persistenceSupervisor.js";
import { PersistenceError } from "../src/contracts/session.js";
import { TestClock, deferred, flush } from "./persistenceHelpers.js";

/** 每个场景持有单独的手动时钟与真实收尾门闩；退出函数不会结束测试进程。 */
function setup() {
  const clock = new TestClock(); const gate = deferred(); const order: string[] = [];
  const exit = vi.fn(); const report = vi.fn();
  const options = { clock, stopInput: vi.fn(() => { order.push("stop"); }), cancel: vi.fn(() => { order.push("cancel"); }), close: vi.fn(() => { order.push("close"); return gate.promise; }), exit, writeError: report };
  const supervisor = new PersistenceSupervisor(options);
  return { clock, gate, order, exit, report, options, supervisor };
}
const original = new PersistenceError("sync_failed", "append", "RAW SECRET /private/path");

describe("T7 五秒故障收尾监督", () => {
  it("先停止输入/取消/等待真实关闭，期限内完成返回5并撤销计时器，保持原分类", async () => {
    const ctx = setup(); const result = ctx.supervisor.fail(original);
    expect(ctx.order).toEqual(["stop", "cancel", "close"]);
    expect(ctx.supervisor.failure).toBe(original);
    ctx.clock.advance(4_999); ctx.gate.resolve(); expect(await result).toBe(5);
    expect(ctx.exit).not.toHaveBeenCalled(); expect(ctx.clock.timers.size).toBe(0);
    expect(ctx.report.mock.calls.flat().join("")).not.toMatch(/RAW SECRET|private\/path/u);
  });

  it("永久挂起且重复故障/信号不重置期限，5000应急退出一次且只调用一次close", async () => {
    const ctx = setup(); const result = ctx.supervisor.fail(original);
    ctx.clock.advance(4_000);
    expect(ctx.supervisor.fail(new PersistenceError("io_timeout", "close", "另一故障"))).toBe(result);
    ctx.clock.advance(999); expect(ctx.exit).not.toHaveBeenCalled(); ctx.clock.advance(1);
    expect(await result).toBe(5); expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(5);
    ctx.clock.advance(60_000); expect(ctx.exit).toHaveBeenCalledOnce(); expect(ctx.options.close).toHaveBeenCalledOnce();
    expect(ctx.supervisor.failure).toBe(original);
  });

  it.each(["resolve", "reject"])("应急退出后迟到 %s 继续被观察，不第二次退出或替换原故障", async (kind) => {
    const ctx = setup(); const result = ctx.supervisor.fail(original); ctx.clock.advance(5_000); await result;
    if (kind === "resolve") ctx.gate.resolve(); else ctx.gate.reject(new Error("late RAW SECRET"));
    await flush(); expect(ctx.exit).toHaveBeenCalledOnce(); expect(ctx.supervisor.failure).toBe(original);
  });

  it("关闭立即失败仍保持监督至5秒，不将失败误认为资源已释放", async () => {
    const ctx = setup(); const result = ctx.supervisor.fail(original);
    ctx.gate.reject(new PersistenceError("close_failed", "close", "关闭失败")); await flush();
    expect(ctx.exit).not.toHaveBeenCalled(); ctx.clock.advance(5_000); expect(await result).toBe(5);
    expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(5); expect(ctx.supervisor.failure).toBe(original);
  });

  it("同步重入、stop/cancel/report/close/exit 抛错均不重置监督或泄漏原始错误", async () => {
    const clock = new TestClock();
    let nested: Promise<5> | undefined;
    const exit = vi.fn(() => { throw new Error("模拟进程已退出"); });
    const supervisor: PersistenceSupervisor = new PersistenceSupervisor({ clock,
      stopInput: () => { nested = supervisor.fail(original); throw new Error("stop"); },
      cancel: () => { throw new Error("cancel"); }, close: () => { throw new Error("close"); },
      writeError: () => { throw new Error("stderr"); }, exit,
    });
    const result = supervisor.fail(original); expect(nested).toBe(result);
    clock.advance(5_000); expect(await result).toBe(5); expect(exit).toHaveBeenCalledOnce();
  });

  it("真实关闭晚于期限但计时回调尚未运行，同样应急退出", async () => {
    const ctx = setup(); const result = ctx.supervisor.fail(original);
    ctx.clock.time = 5_001; ctx.gate.resolve(); expect(await result).toBe(5);
    expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(5);
    expect(ctx.clock.timers.size).toBe(0);
  });
});
