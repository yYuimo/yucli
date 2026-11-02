/** bootstrap 的共享行式 picker/列表呈现；不读取模型配置，不重排已显示编号。 */
import { SessionAccessError } from "../contracts/session.js";
import type { SessionList, SessionListEntry, SessionStore } from "../contracts/session.js";
import type { SessionInput } from "./lineInput.js";

/** 移除终端控制字符并折成一行，供列表、诊断和配置差异提示使用，不把日志原文当终端指令。 */
export function safeLine(text: string): string {
  return [...text].map((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || code >= 127 && code <= 159 ? " " : char;
  }).join("");
}
/** 访问拒绝可回到 picker/原会话；平台或锁服务失效必须停止交互。 */
export function retryableAccess(error: unknown): error is SessionAccessError {
  return error instanceof SessionAccessError && error.code !== "lock_unavailable" && error.code !== "platform_unsupported";
}
/** 显示只读诊断/隐藏计数；默认仅显示无法归属的数量，全局才展开其文件位置。 */
export function listNotes(list: SessionList, all: boolean, write: (text: string) => void, picker = false): void {
  if (list.hiddenEmptyCount) write(`隐藏空会话：${list.hiddenEmptyCount}\n`);
  if (list.unattributedCount) write(`无法归属的文件：${list.unattributedCount}\n`);
  for (const diagnostic of list.diagnostics) {
    if (!all && !diagnostic.cwd) continue;
    write(`诊断 ${picker ? "" : safeLine(diagnostic.sourceBasename) + " "}[${safeLine(diagnostic.code)}] ${safeLine(diagnostic.message)}\n`);
  }
}
/** 输出显式 --sessions 列表，包含完整身份；不显示工具正文、profile 或运行配置。 */
export function printSessionList(list: SessionList, all: boolean, write: (text: string) => void): void {
  for (const entry of list.entries) write(`${entry.sessionId} ${entry.lastActivityAt} ${entry.logState} ${entry.writerState}${entry.changing || entry.writerState !== "available" ? " 仅已观察前缀" : ""}${all ? " " + safeLine(entry.cwd) : ""} ${safeLine(entry.preview)}${entry.reason ? "（" + safeLine(entry.reason) + "）" : ""}\n`);
  if (!list.entries.length) write(all ? "没有可恢复会话。\n" : "当前目录没有可恢复会话。\n");
  listNotes(list, all, write);
}
/** picker 所需能力；select 在选定后加载配置/准备候选，取消时先关闭候选再返回 false。 */
export interface PickerOptions {
  /** 只读观察及正式打开由组合根提供，picker 自身只调用 list。 */
  store: SessionStore;
  /** 与 REPL 相同的输入源，调用期间 picker 是唯一行消费者。 */
  input: SessionInput;
  /** 当前真实工作目录；all 只改变可见范围，不改变这个恢复归属。 */
  cwd: string;
  /** 初始范围，a 切换，r 保持当前范围刷新。 */
  all: boolean;
  /** REPL 当前会话可仅退出选择，不重复申请自己的写锁；启动 picker 省略。 */
  currentSessionId?: string;
  /** stdout 列表/提示与 stderr 安全拒绝原因的注入能力。 */
  write: (text: string) => void;
  /** 不接收原始异常正文；只显示固定原因和稳定分类。 */
  error: (text: string) => void;
  /** 对快照中选定的目标准备/清理；取消 signal 只记录意图，返回 true 才完成选择。 */
  select(entry: SessionListEntry, signal: AbortSignal): Promise<boolean>;
}
/** 选择结果不包含推测的 writer；实际切换由调用方在 select 内完成并保持保存/关闭边界。 */
export type PickerResult = "selected" | "cancelled" | "interrupted" | "eof";
/**
 * CLI/REPL 共用编号快照选择器；只有 a/r 重建快照，访问拒绝保持编号并提示用户刷新。
 * list/select 期间只记取消/EOF意图，等待实际操作及候选清理，不抢占 I/O 或消费下一问题。
 * busy/其他 cwd 不可选，当前会话只关闭 picker；配置/存储/平台故障原样交给组合根。
 */
export async function pickSession(options: PickerOptions): Promise<PickerResult> {
  const { input, store, cwd, write, error } = options;
  const controller = new AbortController();
  let eof = false;
  // observing 只覆盖 list/select 的 I/O；普通输入 EOF 则由 read 直接交付。
  let observing = false;
  const removeInterrupt = input.onInterrupt(() => controller.abort());
  const removeEnd = input.onEnd(() => { if (observing) { eof = true; controller.abort(); } });
  let all = options.all; let snapshot: SessionList | undefined;
  try {
    for (;;) {
      // 仅首次或用户 a/r 后读取新快照；访问拒绝不能把旧编号重排成另一 ID。
      if (!snapshot) {
        observing = true;
        try { snapshot = await store.list({ cwd, all }); } finally { observing = false; }
        if (controller.signal.aborted) return eof ? "eof" : "interrupted";
        write(`恢复会话：${safeLine(cwd)} [${all ? "all" : "current"}]\n`);
        snapshot.entries.forEach((entry, index) => write(`${index + 1}) ${entry.lastActivityAt} ${safeLine(entry.preview)} ${entry.logState} ${entry.writerState}${entry.sessionId === options.currentSessionId ? " 当前会话" : ""}${all ? " " + safeLine(entry.cwd) : ""}${entry.changing || entry.writerState !== "available" ? " 仅已观察前缀" : ""}${entry.reason ? "（" + safeLine(entry.reason) + "）" : ""}\n`));
        if (!snapshot.entries.length) write(all ? "没有可恢复会话。\n" : "当前目录没有可恢复会话。\n");
        listNotes(snapshot, all, write, true);
      }
      // 人工等待不加存储超时；此处是唯一行消费者，下一问题仍留在共享输入队列。
      const event = await input.read("编号 / a 切换范围 / r 刷新 / q 或空行取消：");
      if (event.type === "eof") return "eof";
      if (event.type === "interrupt" || controller.signal.aborted) return "interrupted";
      const answer = event.text.trim();
      if (!answer || answer === "q") return "cancelled";
      if (answer === "a" || answer === "r") { if (answer === "a") all = !all; snapshot = undefined; continue; }
      const entry = /^\d+$/u.test(answer) && Number.isSafeInteger(Number(answer)) ? snapshot.entries[Number(answer) - 1] : undefined;
      if (!entry) { error("无效编号，请输入列表中的正整数或 a/r/q。\n"); continue; }
      // 自己仍持锁时也允许“选择当前会话”；不重复 openWrite，不清空已有历史。
      if (entry.sessionId === options.currentSessionId) return "selected";
      if (entry.cwd !== cwd || entry.writerState === "busy" || entry.resumability === "no" || entry.logState === "corrupt" || entry.logState === "unsupported") { error(safeLine(entry.reason ?? "该会话不可选择。") + "\n"); continue; }
      // select 必须自己等候选实际准备/关闭，signal 只记录意图；不能抢占底层文件 I/O。
      observing = true;
      try {
        const selected = await options.select(entry, controller.signal);
        if (controller.signal.aborted) return eof ? "eof" : "interrupted";
        if (selected) return "selected";
      } catch (cause) {
        // 只有访问拒绝能重试原快照；存储/平台/锁服务故障交组合根停止交互。
        if (!retryableAccess(cause)) throw cause;
        error(`无法打开会话 [${cause.code}]，编号快照保持不变；按 r 刷新。\n`);
        if (controller.signal.aborted) return eof ? "eof" : "interrupted";
      } finally { observing = false; }
    }
  } finally { removeInterrupt(); removeEnd(); }
}
