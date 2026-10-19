/** core 的流式 turn：持有临时消息，不持有 REPL 全局历史，也不直接操作终端。 */
import { AbortError, AgentLoopError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { AgentLoopOptions, StreamTurnResult } from "../contracts/agent.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry, ToolResult } from "../contracts/tool.js";
import { StreamAssembler } from "./streamAssembler.js";
import { resolveLoopLimits } from "./loopLimits.js";
import { executeToolBatch } from "./toolRegistry.js";

/**
 * 在已有完整历史之后完成一个用户 turn，必要时执行多批只读工具，直到生成最终文本。
 * CLI/REPL 调用；history 是旧消息快照，prompt 保留原文，onText 将每个文本片段交给 bootstrap。
 * client/registry 为注入能力，options 默认 8/4，signal 覆盖该 turn 的全部模型和工具操作。
 * 返回完整 StreamTurnResult（含本 turn 新增消息），成功之前不修改 history、不提交半截结果。
 * 异步迭代完整成功后才允许执行工具；全批预检、按序执行、最后一轮不执行工具沿用阶段 02。
 * 协议/额度、模型失败和取消通过稳定异常传播；已通过 onText 显示的片段不回滚。
 * 本函数不打印、不读写文件；网络/文件副作用由注入 adapter 处理和清理。
 */
export async function runTurnStream(
  client: LlmClient,
  registry: ToolRegistry,
  model: string,
  history: readonly Message[],
  prompt: string,
  onText: (text: string) => void,
  options: Partial<AgentLoopOptions> = {},
  signal?: AbortSignal,
): Promise<StreamTurnResult> {
  const limits = resolveLoopLimits(options);
  const appendedMessages: Message[] = [{ role: "user", content: prompt }];
  const toolResults: ToolResult[] = [];
  const tools = registry.definitions();
  for (let modelCalls = 1; modelCalls <= limits.maxModelCalls; modelCalls++) {
    if (signal?.aborted) throw new AbortError("模型循环已取消。");
    const assembler = new StreamAssembler(limits.maxToolCallsPerResponse);
    for await (const event of client.stream({ model, messages: [...history, ...appendedMessages], tools }, signal)) {
      if (signal?.aborted) throw new AbortError("模型循环已取消。");
      assembler.accept(event);
      if (event.type === "text_delta") onText(event.text);
    }
    if (signal?.aborted) throw new AbortError("模型循环已取消。");
    const message = assembler.finish();
    const calls = message.toolCalls ?? [];
    if (!calls.length) {
      appendedMessages.push(message);
      return { finalText: message.content ?? "", modelCalls, toolResults, appendedMessages, stopKind: "final_text" };
    }
    if (modelCalls === limits.maxModelCalls) {
      throw new AgentLoopError("loop_limit", "已达到模型调用次数上限，本次 turn 已停止。");
    }
    appendedMessages.push(message);
    const results = await executeToolBatch(registry, calls, signal);
    for (const result of results) {
      toolResults.push(result);
      appendedMessages.push({ role: "tool", toolCallId: result.toolCallId, name: result.name, content: result.content });
    }
  }
  throw new AgentLoopError("loop_limit", "已达到模型调用次数上限。");
}
