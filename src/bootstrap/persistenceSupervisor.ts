/** bootstrap 层存储故障监督；由未来组合根接入，不实现 CLI/REPL 输入循环或命令。 */
import type { PersistenceClock } from "../contracts/session.js";
import { PersistenceError } from "../contracts/session.js";
import { persistenceClock } from "../adapters/session/sessionOperation.js";

/** 组合根提供的故障收尾能力；测试全部可替换，模块不自行创建会话/取消控制器。 */
export interface PersistenceSupervisorOptions {
  /** 立即停止接受新输入；不在此模块消费或解析输入。 */
  stopInput(): void;
  /** 对当前模型/工具发出业务取消，不能取消必要保存/关闭。 */
  cancel(): void;
  /** 真实 settle/关闭回调，通常接 SessionCleanup.closeSettled；不是有界公开 close 的结果。 */
  close(): Promise<void>;
  /** 仅在收尾 5 秒到期且未证实资源关闭时调用，生产由组合根提供 process.exit。 */
  exit(code: 5): void;
  /** 单调时钟/计时器，固定 5 秒；默认保持进程存活，不 unref。 */
  clock?: PersistenceClock;
  /** 尽力写固定安全摘要；默认 stderr，不接收原始 Error 或路径。 */
  writeError?: (message: string) => void;
}

/** 首次存储故障固定分类与唯一收尾期限；重复故障/信号只等待同一结果。 */
export class PersistenceSupervisor {
  private task: Promise<5> | undefined;
  private original: PersistenceError | undefined;
  private readonly clock: PersistenceClock;

  /** 保存组合根能力及单调时钟；构造不注册信号、不停止输入、不启动退出计时器。 */
  constructor(private readonly options: PersistenceSupervisorOptions) {
    this.clock = options.clock ?? persistenceClock;
  }

  /** 返回首次故障身份供组合根诊断，收尾失败或后来的取消都不覆盖它。 */
  get failure(): PersistenceError | undefined { return this.original; }

  /** 输出固定安全文字；输出失败不能妨碍最终退出或把原始错误写入终端。 */
  private report(message: string): void {
    try { (this.options.writeError ?? ((text: string) => { process.stderr.write(text); }))(message); } catch { /* 尽力输出，不阻断退出。 */ }
  }

  /**
   * 首次 PersistenceError 后停输入/取消业务，再等待真实资源关闭；由组合根故障 catch 调用。
   * 5 秒内清理成功返回退出码 5；挂起/关闭失败到期调用注入 exit(5)，不显式提前解锁。
   * 重入不重置计时，晚到拒绝始终被观察；不写业务 turn_end、不改变原始错误分类。
   */
  fail(error: PersistenceError): Promise<5> {
    if (this.task) return this.task;
    this.original = error;
    // 先缓存 Promise 再调用外部回调，stopInput/cancel 的同步重入也不能启动第二个监督。
    let finish!: (code: 5) => void;
    this.task = new Promise<5>((resolve) => { finish = resolve; });
    let finished = false;
    const began = this.clock.now();
    let cancelTimer = () => {};
    /** 总期限到期才应急退出；测试退出函数返回时也完成同一 Promise，不泄露晚到异常。 */
    const expire = () => {
      if (finished) return;
      finished = true;
      cancelTimer();
      this.report("会话资源未能在 5 秒内关闭，进程将以退出码 5 结束。\n");
      try { this.options.exit(5); } catch { /* 真实退出不会返回；测试替身抛出也不改变退出分类。 */ }
      finish(5);
    };
    cancelTimer = this.clock.schedule(5_000, expire);
    this.report("会话存储发生故障，正在停止执行并关闭资源。\n");
    try { this.options.stopInput(); } catch { /* 仍须尝试取消/关闭，保持原故障。 */ }
    try { this.options.cancel(); } catch { /* 业务取消失败不能跳过资源收尾。 */ }
    let cleanup: Promise<void>;
    try { cleanup = this.options.close(); } catch (cause) { cleanup = Promise.reject(cause); }
    // 失败不证明资源已安全关闭：继续保留 5 秒监督，届时由进程消亡释放内核资源。
    void cleanup.then(() => {
      if (finished) return;
      if (this.clock.now() - began >= 5_000) { expire(); return; }
      finished = true;
      cancelTimer();
      finish(5);
    }, () => {});
    return this.task;
  }
}
