/** bootstrap 的唯一行输入消费者；CLI picker 与 REPL 共享队列，不创建竞争的 readline。 */
import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** 一次用户输入/取消/EOF；判别字段 type 使取消不会被当作普通问题文本。 */
export type LineEvent = { type: "line"; text: string } | { type: "interrupt" } | { type: "eof" };

/** 交互层所需的窄能力；真实实现拥有一个 readline，测试可用可控行队列。 */
export interface SessionInput {
  /** 仅 stdin/stdout 都为 TTY 时允许 picker。 */
  readonly tty: boolean;
  /** EOF 已发生；队列里仍可能存在 EOF 之前送达的行。 */
  readonly closed: boolean;
  /** 顺序取得下一事件；显示传入提示，人工输入没有存储期限，不并发调用。 */
  read(prompt: string): Promise<LineEvent>;
  /** 业务/list/open 等待期间观察取消意图；返回解除订阅函数，不关闭存储。 */
  onInterrupt(listener: () => void): () => void;
  /** 观察 EOF 意图，候选准备可先清理再结束；返回解除订阅函数。 */
  onEnd(listener: () => void): () => void;
  /** 故障后停止输入，丢弃尚未接受的问题并唤醒读者；不触碰会话资源。 */
  stop(): void;
  /** 最终关闭唯一输入源并移除信号监听，不允许后继问题继续交付。 */
  dispose(): void;
}

/** 信号订阅的窄能力；生产 process 与测试 EventEmitter 都可实现，不要求返回整个 Process。 */
interface InterruptSource {
  /** 登记 Ctrl+C 回调；返回值不参与交互状态。 */
  on(event: "SIGINT", listener: () => void): unknown;
  /** 移除相同回调，不改变进程或存储状态。 */
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

/** 一个交互流程的行队列，空闲/执行/picker 对 Ctrl+C 的解释由调用方负责。 */
export class LineInput implements SessionInput {
  readonly tty: boolean;
  private ended = false;
  private stopped = false;
  // lines 是尚未被业务接受的输入；只有 read 才将一行交给当前唯一消费者。
  private readonly lines: string[] = [];
  private waiter: ((event: LineEvent) => void) | undefined;
  private readonly interrupts = new Set<() => void>();
  private readonly endings = new Set<() => void>();
  private readonly rl: Interface;

  /**
   * 建立唯一 readline 和 SIGINT 监听，由 CLI 在参数检查通过后按需创建。
   * input/output/signals 可注入；构造不读取配置/会话，不产生模型请求。
   */
  constructor(
    input: Readable & { isTTY?: boolean } = process.stdin,
    output: Writable & { isTTY?: boolean } = process.stdout,
    private readonly signals: InterruptSource = process,
  ) {
    this.tty = Boolean(input.isTTY && output.isTTY);
    this.rl = createInterface({ input, output, terminal: this.tty });

    /** 只有当前读者存在才立即交付；模型/I/O 期间到达的管道行排队，不启动新 turn。 */
    this.rl.on("line", (text: string) => {
      if (this.stopped) return;
      if (this.waiter) this.deliver({ type: "line", text });
      else this.lines.push(text);
    });

    /** EOF 保留已到达行，让普通管道可完整处理；候选准备则由上层监听请求结束。 */
    this.rl.on("close", () => {
      this.ended = true;
      for (const listener of this.endings) listener();
      if (this.waiter && !this.lines.length) this.deliver({ type: "eof" });
    });
    this.rl.on("SIGINT", this.interrupt);
    this.signals.on("SIGINT", this.interrupt);
  }

  /** 提供 EOF 观测，只读标志不意味着已处理完队列中的先前行。 */
  get closed(): boolean { return this.ended; }

  /** 交付一个等待事件并清掉读者，供 line/SIGINT/close 使用，防止同时 resolve 两次。 */
  private deliver(event: LineEvent): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(event);
  }

  /** 先通知当前业务取消，再唤醒等待中的 picker/普通输入；执行期不留下过期取消事件。 */
  private readonly interrupt = () => {
    for (const listener of this.interrupts) listener();
    if (this.waiter) this.deliver({ type: "interrupt" });
  };

  /**
   * 取一行或等待信号，由 picker/REPL 顺序调用；返回当前事件，不自行解释为模型问题。
   * 停止后总是 EOF；自然 EOF 前的队列可继续读，避免管道输入在执行期间丢失。
   */
  read(prompt: string): Promise<LineEvent> {
    if (this.stopped) return Promise.resolve({ type: "eof" });
    if (!this.ended) { this.rl.setPrompt(prompt); this.rl.prompt(); }
    const text = this.lines.shift();
    if (text !== undefined) return Promise.resolve({ type: "line", text });
    if (this.ended) return Promise.resolve({ type: "eof" });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  /** 登记当前交互取消观察者，返回清理函数；不会创建新的输入消费者。 */
  onInterrupt(listener: () => void): () => void {
    this.interrupts.add(listener);
    return () => { this.interrupts.delete(listener); };
  }

  /** 登记 EOF 意图观察者并返回清理函数，候选准备期间可据此先关闭候选再结束。 */
  onEnd(listener: () => void): () => void {
    this.endings.add(listener);
    return () => { this.endings.delete(listener); };
  }

  /** 停止接受问题并唤醒读者；故障后即使管道已有更多行也不能交付给业务。 */
  stop(): void {
    this.stopped = true;
    this.lines.length = 0;
    this.deliver({ type: "eof" });
    this.rl.close();
  }

  /** 组合根最终清理输入与进程监听；picker 到 REPL 的交接不调用此方法。 */
  dispose(): void {
    this.stop();
    this.signals.removeListener("SIGINT", this.interrupt);
    this.rl.removeListener("SIGINT", this.interrupt);
    this.interrupts.clear();
    this.endings.clear();
  }
}
