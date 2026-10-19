/** core 层的一次模型响应拼装器；不认识 SSE、HTTP 或终端。 */
import { AgentLoopError, ResponseError } from "../contracts/llm-client.js";
import type { AssistantMessage, LlmStreamEvent } from "../contracts/message.js";
import { validateToolBatch } from "./toolRegistry.js";

/**
 * 某个 index 尚在拼接的调用，由 assembler 创建并独占修改；不是已经可以执行的 ToolCall。
 * 字段先为空，message_end 后再要求完整；参数片段只追加到此对象，避免与其他调用串线。
 */
interface ToolCallAssembly {
  /** 本响应中的序号，用于最终按 index 排序，不假定片段按序到达。 */
  index: number;

  /** 由模型生成的调用 ID，可稍后补齐，已经出现的非空值不能变更。 */
  id: string;

  /** 实际请求的工具名称，可稍后补齐；与 ID 一样不作字符串片段累加。 */
  name: string;

  /** 按该 index 到达顺序累计的 JSON 文本，收尾之前不解析执行。 */
  argumentsJson: string;
}

/**
 * 逐个接收内部流式事件，收尾后交付完整 assistant 消息。
 * runTurnStream 为每次模型调用创建独立实例；临时状态不会进入 REPL 的已完成历史。
 */
export class StreamAssembler {
  private text = "";
  private ended = false;
  private readonly calls = new Map<number, ToolCallAssembly>();

  /**
   * 设置本响应最多允许的工具数；runTurnStream 传入已校验的阶段额度，缺省为 4。
   * 构造器只保存额度，不消费流、不发请求；finish 才会交付可执行的完整消息。
   */
  constructor(private readonly maxCalls = 4) {}

  /**
   * 消费一个业务事件并更新本响应状态，供 runTurnStream 按网络顺序调用。
   * 文本保留原文，参数按 index 分开拼接，usage 忽略；无返回值，不执行工具。
   * message_end 到达时整批验证；结束后新内容、缺字段、重复 ID、坏 JSON 等均抛稳定错误。
   */
  accept(event: LlmStreamEvent): void {
    if (event.type === "usage") return;
    if (this.ended) throw new ResponseError("模型消息已经结束，不能继续追加内容。");
    if (event.type === "text_delta") {
      this.text += event.text;
      return;
    }
    if (event.type === "message_end") {
      if (event.finishReason === "length") throw new ResponseError("模型响应被截断，不执行工具。");
      this.ended = true;
      this.finish();
      return;
    }
    if (!Number.isSafeInteger(event.index) || event.index < 0) {
      throw new ResponseError("工具调用 index 必须为非负安全整数。");
    }
    const call = this.calls.get(event.index) ?? { index: event.index, id: "", name: "", argumentsJson: "" };
    for (const field of ["id", "name"] as const) {
      const value = event[field];
      if (value) {
        if (call[field] && call[field] !== value) {
          throw new AgentLoopError("protocol_error", "同一工具序号的 ID 或名称发生变化。");
        }
        call[field] = value;
      }
    }
    call.argumentsJson += event.argumentsDelta ?? "";
    this.calls.set(event.index, call);
    if (this.calls.size > this.maxCalls) throw new AgentLoopError("protocol_error", "工具调用批次数量超限。");
  }

  /**
   * 返回已经完整校验的 assistant 消息，由 turn 在整条 generator 成功结束后调用。
   * 按 index 排序，再复用阶段 02 的整批参数/ID 校验；无调用时要求非空白文本。
   * 缺 message_end 抛 ResponseError；非法工具批次抛 AgentLoopError，均不会执行任何工具。
   * 返回新对象，不包含 usage/finishReason；不会修改 REPL 历史或输出屏幕文字。
   */
  finish(): AssistantMessage {
    if (!this.ended) throw new ResponseError("模型响应缺少 message end。");
    const calls = [...this.calls.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }));
    validateToolBatch(calls, this.maxCalls);
    if (!calls.length && !this.text.trim()) throw new ResponseError("模型未返回非空白文本或工具调用。");
    return { role: "assistant", content: this.text, ...(calls.length ? { toolCalls: calls } : {}) };
  }
}
