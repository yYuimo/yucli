/** bootstrap 的朴素输出函数；无 renderer 接口，core 不依赖终端。 */
import { AbortError, AgentLoopError, ConfigError, RequestError, ResponseError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry } from "../contracts/tool.js";
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
  let wrote = false;
  let newline = true;

  /** 接收 core 的文字片段并原样写 stdout，记录是否需要收尾换行；空片段不改变状态。 */
  const onText = (text: string) => {
    if (!text) return;
    process.stdout.write(text);
    wrote = true;
    newline = text.endsWith("\n");
  };
  try {
    return await runTurnStream(client, registry, model, history, prompt, onText, {}, signal);
  } finally {
    if (wrote && !newline) process.stdout.write("\n");
  }
}

/**
 * 将已分类异常显示为安全错误状态，由 CLI/REPL 在 turn 失败时调用。
 * error 为 unknown，返回对应退出码供外层决定是否结束；本函数只写 stderr，不退出进程。
 * 未分类异常不回显原始 message/stack；已分类错误使用各层保证的安全摘要。
 */
export function reportError(error: unknown): number {
  if (error instanceof ConfigError) {
    process.stderr.write(`配置错误：${error.message}\n`);
    return 3;
  }
  if (
    error instanceof RequestError || error instanceof ResponseError ||
    error instanceof AbortError || error instanceof AgentLoopError
  ) {
    process.stderr.write(`${error.message}\n`);
    return 4;
  }
  process.stderr.write("程序发生未预期错误。\n");
  return 1;
}
