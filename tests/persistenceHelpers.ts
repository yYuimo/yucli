/** T7 测试的可控 Promise 和单调时钟；不等待真实 30 秒/5 秒，不访问进程环境。 */
import type { PersistenceClock } from "../src/contracts/session.js";

/** 测试显式推进 resolve/reject，用于准确观察尚未 settle 的保存/文件/关闭屏障。 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 排空有限的 Promise 继续点；真实文件/HTTP 的到达用单独的 entered Promise 确认。 */
export async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** 手动单调时钟；schedule 与默认能力一致，只安排回调、不取消实际 I/O。 */
export class TestClock implements PersistenceClock {
  time = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  private next = 0;
  /** 取得当前测试毫秒时间；不读 Date 或真实系统时钟。 */
  now() { return this.time; }
  /** 登记一个可取消回调；返回的闭包只删除对应计时器。 */
  schedule(delayMs: number, callback: () => void) {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  }
  /** 按期限顺序触发到期回调；Promise 继续点由测试在推进后显式等待。 */
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.time = target;
  }
}
