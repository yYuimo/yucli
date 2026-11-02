/** adapters 层固定操作期限；公开等待与真实 I/O settle 分离，不取消底层调用或自行解锁。 */
import { PersistenceError } from "../../contracts/session.js";
import type { PersistenceClock, SessionOperation } from "../../contracts/session.js";
import type { SessionFileIO } from "./sessionFileIO.js";

/** 默认单调时钟及保持进程存活的定时器，bootstrap 可复用；测试注入同一窄时间能力。 */
export const persistenceClock: PersistenceClock = {
  now: () => performance.now(),
  schedule: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

/** 一个文件 adapter 及其 writer 共用的期限状态，首次超时后禁止新的业务 I/O。 */
export class SessionOperations {
  private readonly pending = new Set<Promise<unknown>>();
  private timeout: PersistenceError | undefined;

  /** 由 SessionFileAdapter 创建；只保存可注入时间能力，不创建文件或启动计时器。 */
  constructor(private readonly clock: PersistenceClock = persistenceClock) {}

  /** 返回首次超时身份，供 writer/创建器在真实 I/O 结束后的继续点拒绝后继操作。 */
  get failure(): PersistenceError | undefined { return this.timeout; }

  /** 在开始新业务 I/O 前检查永久故障；不影响关闭与释放已经拥有的资源。 */
  assertActive(): void { if (this.timeout) throw this.timeout; }

  /**
   * 给一个公开操作设置固定 30 秒总等待；调用方传入尚未启动的实际流程。
   * 含排队/内部 I/O，不为子步骤重新计时；close 即使已超时也允许启动真实收尾。
   * 超时先固定共享故障再拒绝，原 Promise 继续登记并观察两种 settle，不产生未处理拒绝。
   * 返回公开等待 Promise；期限内实际拒绝原样传播，不转换成超时或业务错误。
   */
  run<T>(operation: SessionOperation, start: () => Promise<T>): Promise<T> {
    if (operation !== "close" && this.timeout) return Promise.reject(this.timeout);
    const began = this.clock.now();
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      /** 固定首次超时并拒绝公开等待；真实资源仍由 preparing/tail/closeSettled 持有。 */
      const expire = () => {
        if (finished) return;
        finished = true;
        this.timeout ??= new PersistenceError("io_timeout", operation, "会话操作等待超过 30 秒，底层 I/O 尚未取得确认。");
        reject(this.timeout);
      };
      const cancelTimer = this.clock.schedule(30_000, expire);
      let task: Promise<T>;
      try { task = start(); } catch (error) { task = Promise.reject(error); }
      this.pending.add(task);
      /** 观察原操作的成功/失败；即便公开等待已超时，也要移除实际 settle 的登记。 */
      const settle = (ok: boolean, value: unknown) => {
        this.pending.delete(task);
        if (!finished && this.clock.now() - began >= 30_000) expire();
        cancelTimer();
        if (finished) return;
        finished = true;
        if (operation !== "close" && this.timeout) { reject(this.timeout); return; }
        // as T 只恢复原 Promise<T> 的结果类型；运行时数据校验仍由实际存储流程负责。
        if (ok) resolve(value as T); else reject(value);
      };
      void task.then((value) => settle(true, value), (error: unknown) => settle(false, error));
    });
  }

  /**
   * 给真实 SessionFileIO 加继续点守卫，短写/备份循环也不能在超时后再发下一次 I/O。
   * 当前已发出的调用仍等待真实 settle；close 始终委托原实现，允许故障资源安全关闭。
   */
  guard(io: SessionFileIO): SessionFileIO {
    /** 调用前复核故障；只包装能力，不吞错误、不改变 I/O 结果或取消底层操作。 */
    const invoke = <T>(start: () => Promise<T>): Promise<T> => { this.assertActive(); return start(); };
    return {
      lstat: (path) => invoke(() => io.lstat(path)), mkdir: (path) => invoke(() => io.mkdir(path)),
      open: (path, flags, mode) => invoke(() => io.open(path, flags, mode)), readdir: (path) => invoke(() => io.readdir(path)),
      realpath: (path) => invoke(() => io.realpath(path)), write: (handle, bytes, position) => invoke(() => io.write(handle, bytes, position)),
      read: (handle, bytes, position) => invoke(() => io.read(handle, bytes, position)), truncate: (handle, size) => invoke(() => io.truncate(handle, size)),
      sync: (handle) => invoke(() => io.sync(handle)), close: (handle) => io.close(handle),
    };
  }
}
