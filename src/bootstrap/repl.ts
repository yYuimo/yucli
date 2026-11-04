/** bootstrap 的持久化 REPL：拥有输入/会话/历史，core 仅交付保存成功凭证。 */
import { randomUUID } from "node:crypto";
import type { LlmClient } from "../contracts/llm-client.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry } from "../contracts/tool.js";
import { PersistenceError, SessionAccessError } from "../contracts/session.js";
import type { OpenedSession, RuntimeProfile, SessionSnapshot, SessionStore } from "../contracts/session.js";
import { projectSessionHistory } from "../core/sessionHistory.js";
import { runPersistentTurn } from "../core/runPersistentTurn.js";
import { renderTurn, reportError } from "./output.js";
import { isSessionId } from "./cliOptions.js";
import type { SessionInput } from "./lineInput.js";
import { pickSession, retryableAccess, safeLine } from "./sessionPicker.js";

/** 启动时配置校验后的业务能力；只保存非敏感 profile，恢复不会重新加载配置。 */
export interface SessionRuntime {
  /** 当前启动环境创建的模型能力，恢复记录不能改变端点或认证。 */
  client: LlmClient;
  /** 当前启动 cwd 的只读工具注册表，不从历史重建旧工具执行。 */
  registry: ToolRegistry;
  /** 本轮实际模型标识，同时进入请求和非敏感 profile。 */
  model: string;
  /** 只含 provider/model，写入 user 外层并用于恢复提示。 */
  profile: RuntimeProfile;
}
/** 组合根提供 REPL 资源；store/输入最后由组合根统一关闭，避免异常路径重复监督。 */
export interface ReplOptions {
  /** 启动时已校验的模型/工具能力，切换期间不重新加载。 */
  runtime: SessionRuntime;
  /** 组合根拥有的存储及规范 cwd；REPL 只管理当前 writer。 */
  store: SessionStore;
  cwd: string;
  /** picker/普通问题共用的唯一输入源。 */
  input: SessionInput;
  /** 显式恢复成功的候选；省略表示首次普通问题才 create。 */
  initial?: OpenedSession;
  /** 存储故障监督的取消信号，不与普通 Ctrl+C 共用不可重置的控制器。 */
  faultSignal: AbortSignal;
  /** stdout 文本与 stderr 安全状态，可在测试中独立观察。 */
  write: (text: string) => void;
  error: (text: string) => void;
  /** 每个接受的新问题分配新身份；测试可控，不继续旧 turnId。 */
  uuid?: () => string;
}

/** 显式恢复后只报告元信息/计数/尾部动作，不重印用户、工具或模型的历史正文。 */
export function announceRecovery(snapshot: SessionSnapshot, error: (text: string) => void): void {
  error(`恢复会话：${snapshot.meta.sessionId}；成功 ${snapshot.recentSuccessfulTurns.length} 轮；中断 ${snapshot.interruptedTurnCount} 轮；尾部 ${snapshot.repair}。\n`);
}

/**
 * 首次新请求前比较最近成功 turn 的摘要，由恢复后的 REPL 调用。
 * 输入恢复快照和当前 profile；无成功 turn 才回退最近 user，返回安全提示或空字符串。
 * 最近成功 turn 缺摘要时保持未知，不借用其他记录；纯计算，不加载配置/修改模型消息。
 */
export function profileNotice(snapshot: SessionSnapshot, profile: RuntimeProfile): string {
  const latestSuccessfulTurn = snapshot.recentSuccessfulTurns.at(-1);
  // 判断成功 turn 是否存在，而非其 profile 是否存在，避免缺摘要时错误回退最近 user。
  const previous = latestSuccessfulTurn ? latestSuccessfulTurn.runtimeProfile : snapshot.lastUserProfile;
  if (!previous) return "恢复记录缺少运行摘要，无法完整核对 provider/model。\n";
  if (previous.provider === profile.provider && previous.model === profile.model) return "";
  return `恢复历史使用 ${safeLine(previous.provider)}/${safeLine(previous.model)}，当前使用 ${safeLine(profile.provider)}/${safeLine(profile.model)}。\n`;
}

/**
 * 运行已加载配置的 REPL；首次普通问题惰性 create，每次完整凭证后才整组提交历史。
 * /resume 先准备候选再关闭旧写者，访问拒绝保留旧历史；保存/关闭/锁故障原样上交监督。
 * 返回正常 0 或闲置取消 130；只消费同一个 SessionInput，不自行创建 readline 或退出进程。
 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const { runtime, store, cwd, input, write, error } = options;
  let current = options.initial;
  let turns: (readonly Message[])[] = current ? projectSessionHistory(current.snapshot.recentSuccessfulTurns) : [];
  let notice = current ? profileNotice(current.snapshot, runtime.profile) : "";
  let active: AbortController | undefined;
  let selecting = false;
  let idleInterrupted = false;
  let endRequested = false;
  const removeInterrupt = input.onInterrupt(() => {
    if (selecting) return; // picker/候选准备自己记录意图，不能把它当普通提示 Ctrl+C。
    if (active) active.abort();
    else { idleInterrupted = true; input.stop(); }
  });

  /**
   * 打开选定 ID，取消时先真正关闭候选；旧 close 开始后切换固定，迟到信号不复活旧 writer。
   * 访问异常不改变 current/turns；close 或修复异常交给组合根处理全部已登记资源。
   */
  const switchTo = async (id: string, signal: AbortSignal): Promise<boolean> => {
    if (id === current?.snapshot.meta.sessionId) return true;
    const candidate = await store.openWrite({ sessionId: id, cwd });
    if (signal.aborted) { await candidate.writer.close(); return false; }
    // 从这一 await 开始不再取消切换；若关闭失败，候选仍由 store 登记并统一收尾。
    await current?.writer.close();
    current = candidate;
    turns = projectSessionHistory(candidate.snapshot.recentSuccessfulTurns);
    notice = profileNotice(candidate.snapshot, runtime.profile);
    announceRecovery(candidate.snapshot, error);
    return true;
  };

  try {
    for (;;) {
      if (idleInterrupted) return 130;
      if (endRequested) return 0;
      const event = await input.read("yucli> ");
      if (idleInterrupted || event.type === "interrupt") return 130;
      if (event.type === "eof") return 0;
      const command = event.text.trim();
      if (!command) continue;
      if (command === "/exit" || command === "/quit") return 0;
      if (command === "/help") {
        write("/new（/clear 同义）：关闭旧会话并清空历史；/resume [ID|--all]：恢复；/exit /quit：退出；/help：帮助。\n");
        continue;
      }
      if (command === "/new" || command === "/clear") {
        // 旧 close 必须确认；失败不能继续创建新会话或消费管道中下一条问题。
        await current?.writer.close();
        current = undefined; turns = []; notice = "";
        continue;
      }
      if (/^\/(?:new|clear|exit|quit|help)(?:\s|$)/u.test(command)) {
        error("命令用法错误：该命令不接受参数。\n"); continue;
      }
      if (/^\/resume(?:\s|$)/u.test(command)) {
        const args = command.split(/\s+/u).slice(1);
        if (args.length > 1 || args[0] !== undefined && args[0] !== "--all" && !isSessionId(args[0])) {
          error("用法：/resume [完整 sessionId|--all]。\n"); continue;
        }
        const picker = !args.length || args[0] === "--all";
        if (picker && !input.tty) { error("选择器需要 stdin/stdout 都是 TTY；请使用 --sessions 或 /resume <sessionId>。\n"); continue; }
        selecting = true;
        try {
          if (picker) {
            const result = await pickSession({
              store, input, cwd, all: args[0] === "--all", write, error,
              ...(current ? { currentSessionId: current.snapshot.meta.sessionId } : {}),
              select: (entry, signal) => switchTo(entry.sessionId, signal),
            });
            if (result === "eof") endRequested = true;
          } else {
            const controller = new AbortController();
            const offInterrupt = input.onInterrupt(() => controller.abort());
            const offEnd = input.onEnd(() => { endRequested = true; controller.abort(); });
            try { await switchTo(args[0]!, controller.signal); }
            catch (cause) { if (retryableAccess(cause)) reportError(cause, error); else throw cause; }
            finally { offInterrupt(); offEnd(); }
          }
        } finally { selecting = false; }
        continue;
      }

      // create 是接受普通问题后的首个存储屏障，单独位于业务错误 catch 外；任何失败都停止交互。
      active = new AbortController();
      try {
        if (!current) {
          current = await store.create(cwd);
          error(`新会话：${current.snapshot.meta.sessionId}\n`);
        }
        if (notice) { error(notice); notice = ""; }
        try {
          // 保存稳定的本轮能力，异步显示闭包无需读取稍后会切换的 current/active。
          const writer = current.writer;
          const signal = AbortSignal.any([active.signal, options.faultSignal]);
          const committed = await renderTurn((onText) => runPersistentTurn({
            writer, turnId: (options.uuid ?? randomUUID)(), runtimeProfile: runtime.profile,
            client: runtime.client, registry: runtime.registry, model: runtime.model,
            history: turns.flat(), prompt: event.text, onText,
            signal,
          }), write);
          // 唯一历史提交点；显示文字/裸业务结果或未确认 turn_end 均到不了这里。
          turns = [...turns, committed.result.appendedMessages].slice(-20);
        } catch (cause) {
          if (cause instanceof PersistenceError || cause instanceof SessionAccessError) throw cause;
          reportError(cause, error);
        }
      } finally { active = undefined; }
    }
  } finally { removeInterrupt(); }
}
