import { AbortError, AgentLoopError, ResponseError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { AgentLoopOptions, AgentLoopResult } from "../contracts/agent.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry, ToolResult } from "../contracts/tool.js";
import { validateToolBatch } from "./toolRegistry.js";

/**
 * 完成一次命令中的“模型 → 工具 → 模型”顺序循环，由 CLI 注入客户端和注册表。
 * prompt 创建初始 user 消息；历史和执行结果只存在当前调用，不写入磁盘。
 * 成功返回最终文本、模型调用次数和工具结果；协议/模型/取消失败直接抛出，不返回部分 result。
 * options 供测试缩小上限，signal 同时传给模型和工具；默认最多 8 次模型、每批 4 个调用。
 */
export async function agentLoop(
  client: LlmClient,
  registry: ToolRegistry,
  model: string,
  prompt: string,
  options: Partial<AgentLoopOptions> = {},
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  const maxModelCalls = options.maxModelCalls ?? 8;
  const maxToolCalls = options.maxToolCallsPerResponse ?? 4;

  if (
    !Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 8 ||
    !Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 4
  ) {
    throw new AgentLoopError("protocol_error", "循环选项超出阶段 02 的允许范围。");
  }

  const messages: Message[] = [{ role: "user", content: prompt }];
  const toolResults: ToolResult[] = [];
  const tools = registry.definitions();

  for (let modelCalls = 1; modelCalls <= maxModelCalls; modelCalls++) {
    if (signal?.aborted) throw new AbortError("模型循环已取消。");

    // 为每轮创建数组快照，避免下一轮 push 改变之前请求的消息数量。
    const response = await client.complete({ model, messages: [...messages], tools }, signal);
    if (signal?.aborted) throw new AbortError("模型循环已取消。");

    if (response.finishReason === "length") {
      throw new ResponseError("模型响应被截断，不执行工具。");
    }

    const message = response.message;
    const calls = message.toolCalls ?? [];
    validateToolBatch(calls, maxToolCalls);

    if (!calls.length) {
      if (message.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) {
        throw new ResponseError("模型未返回最终文本或工具调用。");
      }

      return { finalText: message.content, modelCalls, toolResults, stopKind: "final_text" };
    }

    // 先判断模型额度再执行整批工具，最后一轮不能产生模型无机会消费的结果。
    if (modelCalls === maxModelCalls) {
      throw new AgentLoopError("loop_limit", "已达到模型调用次数上限，本次命令已停止。");
    }

    if (message.role !== "assistant") {
      throw new AgentLoopError("protocol_error", "工具调用必须来自 assistant 消息。");
    }

    messages.push(message);

    // for...of + await 保证先完成一个调用再开始下一个，不使用并发 Promise.all。
    for (const call of calls) {
      if (signal?.aborted) throw new AbortError("工具循环已取消。");

      const result = await registry.execute(call, signal);
      if (signal?.aborted) throw new AbortError("工具循环已取消。");

      toolResults.push(result);
      messages.push({
        role: "tool", toolCallId: result.toolCallId, name: result.name, content: result.content,
      });
    }
  }

  throw new AgentLoopError("loop_limit", "已达到模型调用次数上限。");
}
