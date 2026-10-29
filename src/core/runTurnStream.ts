/** core 的流式 turn：持有临时消息，不持有 REPL 全局历史，也不直接操作终端。 */
import { AbortError, AgentLoopError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { AgentLoopOptions, StreamTurnResult } from "../contracts/agent.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry, ToolResult } from "../contracts/tool.js";
import type { TurnExecutionContext } from "../contracts/session.js";
import { StreamAssembler } from "./streamAssembler.js";
import { resolveLoopLimits } from "./loopLimits.js";
import { executeToolBatch } from "./toolRegistry.js";
import { toolResultToMessage } from "./toolMessage.js";

/**
 * 在已有完整历史之后完成一个用户 turn，必要时执行多批只读工具，直到生成最终文本。
 * CLI/REPL 调用；history 是旧消息快照，prompt 保留原文，onText 将每个文本片段交给 bootstrap。
 * client/registry 为注入能力，options 默认 8/4，signal 覆盖该 turn 的全部模型和工具操作。
 * context 可选，存在时逐条 await assistant/工具事实屏障；user/turn_end 由后续协调方保存。
 * 返回完整 StreamTurnResult（含本 turn 新增消息），成功之前不修改 history、不提交半截结果。
 * 异步迭代完整成功后才允许执行工具；全批预检、按序执行、最后一轮不执行工具沿用阶段 02。
 * 协议/额度、工具内部错误、模型失败和取消通过稳定异常传播；保存故障原样穿透。
 * 已通过 onText 显示的片段不回滚；返回的临时成功结果不代表 turn_end 已保存。
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
  context?: TurnExecutionContext,
): Promise<StreamTurnResult> {
  // 1. 在任何网络请求之前确定额度。一次 turn 可能经历多次模型响应，
  // 但这些响应共用这组额度，不能在每次工具往返后重新获得 8 次机会。
  const limits = resolveLoopLimits(options);

  // 旧 history 属于 REPL；本数组只保存本 turn 的临时消息，从新问题开始。
  // 后面即使已经执行过工具，只要 turn 最终失败，就不会把这个数组交给 REPL 提交。
  const appendedMessages: Message[] = [{ role: "user", content: prompt }];
  const toolResults: ToolResult[] = [];
  const tools = registry.definitions();

  // 2. 每次迭代代表一次模型请求，不代表一次用户输入，也不代表一次工具执行。
  for (let modelCalls = 1; modelCalls <= limits.maxModelCalls; modelCalls++) {
    if (signal?.aborted) throw new AbortError("模型循环已取消。");

    // 拼装器只属于本次模型响应，不能沿用上一轮的文本、index 或参数片段。
    const assembler = new StreamAssembler(limits.maxToolCallsPerResponse);

    // 3. 展开数组形成此次请求的历史快照：旧完整 turn + 当前 turn 已产生的消息。
    // for await 会等待 generator 的下一个事件，期间可以逐片输出，无须等整段回答读完。
    for await (const event of client.stream({ model, messages: [...history, ...appendedMessages], tools }, signal)) {
      if (signal?.aborted) throw new AbortError("模型循环已取消。");

      // 先让拼装器检查并记录事件，再把合法文本交给输出函数。
      // 工具 delta 只进入内存，不在这里执行；usage 也不会作为聊天文字输出。
      assembler.accept(event);
      if (event.type === "text_delta") onText(event.text);
    }

    // 4. 离开 for await 表示整条 generator 正常结束，而不只是收到 message_end。
    // message_end 后若又有非法收尾帧，迭代会抛错，根本到不了工具执行位置。
    if (signal?.aborted) throw new AbortError("模型循环已取消。");
    const message = assembler.finish();
    const calls = message.toolCalls ?? [];
    const assistantId = `a${modelCalls}`;

    // 只在整条 stream/assembler/全批校验都成功后交付完整 assistant（含最终回答）。
    // 即使最后一轮已无额度执行工具，该条合法调用事实也先保存，再由上层表达 loop_limit。
    if (context) await context.facts.record({ type: "assistant", turnId: context.turnId, assistantId, message });

    // 5. 没有工具调用意味着模型已完成回答。把最终 assistant 也纳入消息组后，
    // 一次性返回完整结果；持久化路径仍须由后续协调方固定 outcome、保存 turn_end 才可提交。
    if (!calls.length) {
      appendedMessages.push(message);
      return { finalText: message.content ?? "", modelCalls, toolResults, appendedMessages, stopKind: "final_text" };
    }

    // 6. 最后一次机会若仍要求工具，先停止，避免读完文件后已无额度把结果交回模型。
    // 此判断必须放在 executeToolBatch 之前，即使参数完全合法也不能先执行。
    if (modelCalls === limits.maxModelCalls) {
      throw new AgentLoopError("loop_limit", "已达到模型调用次数上限，本次 turn 已停止。");
    }

    // 7. 保留模型提出的完整调用，再顺序取得整批结果。
    // await 期间若失败/取消，不会返回半批结果；本地临时消息也不会被外层提交。
    appendedMessages.push(message);
    const results = await executeToolBatch(registry, calls, signal, context ? { ...context, assistantId } : undefined);
    for (const result of results) {
      toolResults.push(result);

      // 模型靠 toolCallId 将每条结果对应到先前的请求，而不是靠文件内容或数组位置。
      // 下一次循环会把 assistant 调用和这些 tool 消息一起发送，继续生成最终答案。
      appendedMessages.push(toolResultToMessage(result));
    }
  }

  // 防御性的停止出口；当前正常流程会在最终文本分支返回，或在最后一轮工具分支抛错。
  throw new AgentLoopError("loop_limit", "已达到模型调用次数上限。");
}
