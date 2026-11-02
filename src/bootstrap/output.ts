/** bootstrap 的朴素输出函数；无 renderer 接口，core 不依赖终端。 */
import { AbortError, AgentLoopError, ConfigError, RequestError, ResponseError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry } from "../contracts/tool.js";
import { PersistenceError, SessionAccessError } from "../contracts/session.js";
import { ToolExecutionError } from "../contracts/tool.js";
import type { StreamTurnResult } from "../contracts/agent.js";
import { runTurnStream } from "../core/runTurnStream.js";

/**
 * 显示一轮流式文本，并在成功/失败收尾时补足换行，供单次 CLI 和 REPL 共用。
 * client/registry/model 为已组装能力，history/prompt 为当前输入，signal 控制整轮取消。
 * 返回 core 的完整成功结果，失败原样向外抛；部分文字保留屏幕上，不产生历史提交。
 * 只把 text_delta 写 stdout，不显示工具参数、reasoning 或 usage；不写 stderr。
 */
export async function displayTurn(
  client: LlmClient,
  registry: ToolRegistry,
  model: string,
  history: readonly Message[],
  prompt: string,
  signal: AbortSignal,
): Promise<StreamTurnResult> {
  return renderTurn((onText) => runTurnStream(client, registry, model, history, prompt, onText, {}, signal));
}

/**
 * 共用流式文本/换行收尾；单次模式与持久化协调器都由 bootstrap 传入执行闭包。
 * 只显示文字，不提交历史；泛型 T 保留持久化凭证或临时结果的区别，失败原样上抛。
 */
export async function renderTurn<T>(
  execute: (onText: (text: string) => void) => Promise<T>,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
): Promise<T> {
  let wrote = false;
  let newline = true;
  /** 立即显示已取得文字；保存是否需要换行，不缓存协议或整份回答。 */
  const onText = (text: string) => {
    if (!text) return;
    write(text);
    wrote = true;
    newline = text.endsWith("\n");
  };
  try { return await execute(onText); }
  finally { if (wrote && !newline) write("\n"); }
}

/**
 * 将已分类异常显示为安全错误状态，由 CLI/REPL 在 turn 失败时调用。
 * error 为 unknown，返回对应退出码供外层决定是否结束；本函数只写 stderr，不退出进程。
 * 未分类异常不回显原始 message/stack；已分类错误使用各层保证的安全摘要。
 */
export function reportError(error: unknown, write: (text: string) => void = (text) => { process.stderr.write(text); }): number {
  // 存储错误只显示稳定分类，不能把路径、原始 Error 或底层系统摘要写到终端。
  if (error instanceof SessionAccessError || error instanceof PersistenceError) {
    write(`会话${error instanceof PersistenceError ? "存储故障" : "访问失败"} [${error.code}]。\n`);
    return 5;
  }
  if (error instanceof ToolExecutionError) {
    write("工具执行发生内部错误。\n");
    return 4;
  }
  // 使用运行时存在的错误类区分来源；interface 编译后消失，不能用于 instanceof。
  if (error instanceof ConfigError) {
    write(`配置错误：${error.message}\n`);
    return 3;
  }

  // 这些错误均由下层整理为安全说明。单次模式用返回值设置退出码，
  // REPL 则只使用显示副作用，保留进程继续接受下一轮输入。
  if (
    error instanceof RequestError || error instanceof ResponseError ||
    error instanceof AbortError || error instanceof AgentLoopError
  ) {
    write(`${error.message}\n`);
    return 4;
  }

  // 未分类异常没有经过安全摘要处理，不直接输出 message/stack，避免泄露内部信息。
  write("程序发生未预期错误。\n");
  return 1;
}
