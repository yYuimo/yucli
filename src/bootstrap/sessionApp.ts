/** bootstrap 持久化组合流程；列表/选择与配置/写入分开，统一管理故障监督和最终关闭。 */
import type { CliMode } from "./cliOptions.js";
import type { OpenedSession, PersistenceClock, SessionStore } from "../contracts/session.js";
import { PersistenceError, SessionAccessError } from "../contracts/session.js";
import type { SessionInput } from "./lineInput.js";
import { announceRecovery, runRepl, type SessionRuntime } from "./repl.js";
import { listNotes, pickSession, printSessionList } from "./sessionPicker.js";
import { PersistenceSupervisor } from "./persistenceSupervisor.js";
import { reportError } from "./output.js";

/** 持久化组合根注入项；测试用临时 store/本地 SSE，生产不内置假模型或存储覆盖参数。 */
export interface SessionAppOptions {
  /** 同一进程的真实资源所有者；list/open/create 都登记在这里。 */
  store: SessionStore;
  /** 启动 cwd 的 realpath，工具和恢复都使用这个固定归属。 */
  cwd: string;
  /** 输入按需创建，--sessions 不需要 readline；CLI 在调用前完成无 ID picker TTY 检查。 */
  input(): SessionInput;
  /** 首次需要新请求/写恢复时才校验配置并创建真实模型能力，成功结果本次进程复用。 */
  runtime(): SessionRuntime;
  /** 新 REPL 接受首次问题前做 T2 无副作用能力检查；openWrite 内部也有相同预检。 */
  preflight(): Promise<void>;
  /** stdout 显示与 stderr 状态分离，测试无需重定向进程全局流。 */
  write: (text: string) => void;
  /** 接收安全状态文字，不传入原始 Error/路径/请求体。 */
  error: (text: string) => void;
  /** 仅组合根能提供真实退出；单元测试必须注入替身，T9 才验收故障子进程。 */
  exit(code: 5): void;
  /** 可控 5 秒监督时钟；生产省略，人工输入不使用该计时器。 */
  clock?: PersistenceClock;
}

/**
 * 执行 sessions/continue/resume/新 REPL，返回退出码；prompt 仍由 CLI 走非持久化路径。
 * 配置失败早于 openWrite，访问拒绝由 picker 原快照重选；PersistenceError 停输入并监督真实关闭。
 * 正常退出也等待公开 close，任何收尾故障优先于 0/130；finally 移除唯一输入监听。
 */
export async function runSessionApp(mode: Exclude<CliMode, { type: "prompt" }>, options: SessionAppOptions): Promise<number> {
  const { store, cwd, write, error } = options;
  let input: SessionInput | undefined;
  let runtime: SessionRuntime | undefined;
  const fault = new AbortController();
  const supervisor = new PersistenceSupervisor({
    stopInput: () => input?.stop(), cancel: () => fault.abort(), close: () => store.closeSettled(),
    exit: options.exit, writeError: error, ...(options.clock ? { clock: options.clock } : {}),
  });
  /** 只有写恢复/新 REPL 才加载模型配置；picker 浏览/取消和无候选 continue 均不触发。 */
  const loadRuntime = () => runtime ??= options.runtime();
  /** 延迟建立唯一输入队列；同一个实例从启动 picker 直接交给 REPL，不丢失预送行。 */
  const getInput = () => input ??= options.input();

  /** 已选定目标才打开；取消不抢占真实 I/O，待返回候选后关闭，拒绝不产生后继执行。 */
  const open = async (id: string, signal: AbortSignal): Promise<OpenedSession | undefined> => {
    loadRuntime();
    const candidate = await store.openWrite({ sessionId: id, cwd });
    if (signal.aborted) { await candidate.writer.close(); return undefined; }
    return candidate;
  };

  /** 只读选定、加载配置、准备写者后进入 REPL；错误统一由外层分类并关闭资源。 */
  const execute = async (): Promise<number> => {
    if (mode.type === "sessions") { printSessionList(await store.list({ cwd, all: mode.all }), mode.all, write); return 0; }
    let initial: OpenedSession | undefined;
    if (mode.type === "resume" && !mode.id) {
      const result = await pickSession({
        store, cwd, all: mode.all, input: getInput(), write, error,
        select: async (entry, signal) => { initial = await open(entry.sessionId, signal); return Boolean(initial); },
      });
      if (result !== "selected") return result === "interrupted" ? 130 : 0;
    } else if (mode.type === "resume" || mode.type === "continue") {
      let id: string;
      // 直接 ID 先校验配置；continue 先做只读候选选择，无候选不要求密钥。
      if (mode.type === "continue") {
        const list = await store.list({ cwd, all: false });
        listNotes(list, false, write);
        const entry = list.entries.find((item) => item.cwd === cwd && item.turnCount > 0 && item.logState !== "empty" && item.logState !== "corrupt" && item.logState !== "unsupported");
        if (!entry) { error("当前目录没有可恢复会话。\n"); throw new SessionAccessError("not_found", "continue", "当前目录没有可恢复会话。"); }
        id = entry.sessionId; // busy/unknown/changing 都不改选更旧候选。
      } else id = mode.id!;
      loadRuntime();
      const source = getInput();
      const controller = new AbortController();
      const off = source.onInterrupt(() => controller.abort());
      try { initial = await open(id, controller.signal); }
      finally { off(); }
      if (!initial) return 130;
    } else {
      loadRuntime();
      await options.preflight(); // 不创建 root/锁/正文；输入队列尚未开始消费问题。
    }
    if (initial) announceRecovery(initial.snapshot, error);
    return runRepl({
      runtime: loadRuntime(), store, cwd, input: getInput(), faultSignal: fault.signal, write, error,
      ...(initial ? { initial } : {}),
    });
  };

  let code: number;
  try {
    try { code = await execute(); }
    catch (cause) {
      input?.stop();
      code = reportError(cause, error);
      if (cause instanceof PersistenceError) return await supervisor.fail(cause);
    }
    try { await store.close(); }
    catch (cause) {
      const failure = cause instanceof PersistenceError ? cause : new PersistenceError("close_failed", "close", "会话资源关闭失败。");
      reportError(failure, error);
      return await supervisor.fail(failure);
    }
    return code;
  } finally { input?.dispose(); }
}
