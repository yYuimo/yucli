import { AbortError, AgentLoopError, ResponseError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { AgentLoopOptions, AgentLoopResult } from "../contracts/agent.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry, ToolResult } from "../contracts/tool.js";
import { resolveLoopLimits } from "./loopLimits.js";
import { executeToolBatch, validateToolBatch } from "./toolRegistry.js";
import { toolResultToMessage } from "./toolMessage.js";

/**
 * 完成用户一次提问中的工具循环：模型要文件时先执行工具，再把结果交回模型，直到得到最终文本。
 * 保留给非流式调用方和阶段 02 测试；阶段 03 CLI 使用 runTurnStream。本函数拥有本次调用的历史、次数和工具结果。
 * 每轮先检查模型响应和整批工具结构，再判断额度，最后才顺序执行工具并追加消息。
 * 有工具调用时即使同时带文本，也要等工具往返完成，不能提前把该段文本当最终回答。
 *
 * @param client 调用方注入的模型客户端；本层只调用接口，不处理 HTTP 或提供方 JSON。
 * @param registry CLI 注入的注册表，提供工具定义和按名称执行的能力。
 * @param model 本次命令使用的模型标识，传给每一轮请求。
 * @param prompt 已由 CLI 检查非空白的用户原文，作为第一条 user 消息。
 * @param options 可覆盖部分额度；默认 8 次模型调用、每批 4 个工具，测试可缩小但不能放大。
 * @param signal 可选的命令级取消信号，同时传给模型和工具，取消后不再追加成功结果。
 * @returns 最终回答、实际模型调用次数、已执行工具结果和 final_text 停止原因。
 * @throws AgentLoopError 选项/工具协议非法或达到调用上限；最后一轮若仍要工具，不执行该批。
 * @throws ResponseError 响应被截断或没有可用文本/调用；模型请求错误继续向上抛。
 * @throws AbortError 调用方取消；失败不返回部分 AgentLoopResult。
 * 历史只存在本次调用中；网络/文件副作用由注入的实现执行，本函数不读写磁盘或打印。
 */
export async function agentLoop(
  // Pick 只要求兼容路径用到的 complete 方法，不强迫旧调用方补实现 stream。
  client: Pick<LlmClient, "complete">,
  registry: ToolRegistry,
  model: string,
  prompt: string,
  options: Partial<AgentLoopOptions> = {},
  signal?: AbortSignal,
): Promise<AgentLoopResult> {
  // 两种循环共用额度校验；Partial 允许调用方只覆盖一个选项。
  const { maxModelCalls, maxToolCallsPerResponse: maxToolCalls } = resolveLoopLimits(options);

  // 历史只属于本次调用，从 user 原文开始；模型调用和工具结果按顺序追加，不写全局状态。
  const messages: Message[] = [{ role: "user", content: prompt }];
  const toolResults: ToolResult[] = [];
  const tools = registry.definitions();

  for (let modelCalls = 1; modelCalls <= maxModelCalls; modelCalls++) {
    if (signal?.aborted) throw new AbortError("模型循环已取消。");

    // 为每轮创建数组快照，避免下一轮 push 改变之前请求的消息数量。
    const response = await client.complete({ model, messages: [...messages], tools }, signal);

    // 网络 Promise 完成不保证 turn 尚未取消，使用返回结果前再次检查。
    if (signal?.aborted) throw new AbortError("模型循环已取消。");

    if (response.finishReason === "length") {
      throw new ResponseError("模型响应被截断，不执行工具。");
    }

    const message = response.message;
    const calls = message.toolCalls ?? [];

    // 全批校验在 messages.push 和任何 execute 之前完成，不能先做合法的第一项。
    validateToolBatch(calls, maxToolCalls);

    // 没有工具才判断最终文本；有工具即使同时带文字，也必须继续往返而不能提前成功。
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

    // 先保存模型提出的完整调用，再追加相应工具结果，下一次请求才能正确理解每项结果来源。
    messages.push(message);

    // 共用顺序执行器；整批执行成功后才追加完整的工具结果组。
    const results = await executeToolBatch(registry, calls, signal);
    for (const result of results) {
      toolResults.push(result);

      // 本地结果的 ok 用于诊断；模型通过 tool 消息的 ID 和 content 看到执行结果。
      messages.push(toolResultToMessage(result));
    }
  }

  // 防御性出口；额度耗尽时不返回半成品结果，也不会悄悄发起第 9 次请求。
  throw new AgentLoopError("loop_limit", "已达到模型调用次数上限。");
}
