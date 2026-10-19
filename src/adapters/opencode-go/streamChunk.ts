/** adapters 内部的 OpenAI chunk 映射；与 SSE 字节边界和 core 工具拼装分开。 */
import { ResponseError } from "../../contracts/llm-client.js";
import type { LlmStreamEvent, LlmUsage } from "../../contracts/message.js";

/**
 * 判断未知 JSON 是否可作为属性对象继续检查；下方映射函数调用。
 * 不接受 null/数组，不修改输入；true 只说明可读属性，不保证业务结构正确。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 将一个完整 SSE data JSON 转成有序业务事件，由客户端逐帧调用。
 * 输入尚不可信；先验证 choice/delta/字段类型，再产出文本、工具、结束和用量事件。
 * 不拼参数、不执行工具；非法外层字段和 length 抛 ResponseError，不回显原始内容。
 * 去重 usage 以及 message_end 的前后顺序由每请求客户端状态检查。
 */
export function parseStreamChunk(data: string): LlmStreamEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new ResponseError("流式响应不是合法 JSON。");
  }
  const choice = isRecord(value) && Array.isArray(value.choices) ? value.choices[0] as unknown : undefined;
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ResponseError("流式响应需要 choice 和 delta 对象。");
  }
  const delta = choice.delta;
  const reason = choice.finish_reason;
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new ResponseError("流式 finish_reason 必须是字符串。");
  }
  if (reason === "length") throw new ResponseError("模型响应被截断，不执行工具。");

  const events: LlmStreamEvent[] = [];
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") throw new ResponseError("流式 content 必须是文本。");
    events.push({ type: "text_delta", text: delta.content });
  }
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) throw new ResponseError("流式工具调用必须是数组。");
    for (const call of delta.tool_calls as unknown[]) {
      if (
        !isRecord(call) || typeof call.index !== "number" || !Number.isSafeInteger(call.index) || call.index < 0 ||
        (call.type !== undefined && call.type !== "function") ||
        (call.id !== undefined && typeof call.id !== "string") ||
        (call.function !== undefined && !isRecord(call.function))
      ) throw new ResponseError("流式工具调用字段非法。");

      const fn = isRecord(call.function) ? call.function : {};
      if (
        (fn.name !== undefined && typeof fn.name !== "string") ||
        (fn.arguments !== undefined && typeof fn.arguments !== "string")
      ) throw new ResponseError("流式工具名称或参数片段非法。");

      events.push({
        type: "tool_call_delta", index: call.index,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn.arguments === "string" ? { argumentsDelta: fn.arguments } : {}),
      });
    }
  }
  if (typeof reason === "string") events.push({ type: "message_end", finishReason: reason });

  // SSE 的中间帧可用 null 表示统计尚未可用；它不是一份空用量对象。
  if (isRecord(value) && value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) throw new ResponseError("流式 usage 必须是对象。");
    const usage: LlmUsage = {};
    for (const [source, target] of [
      ["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"],
    ] as const) {
      const count = value.usage[source];
      if (count !== undefined) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new ResponseError("流式 token 用量必须是非负安全整数。");
        }
        usage[target] = count;
      }
    }
    events.push({ type: "usage", usage });
  }
  return events;
}
