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
 * 校验并规范化一份 SSE 用量对象，供普通消息帧和 usage-only 帧共用。
 * value 来自尚未验证的 JSON；返回只含 inputTokens/outputTokens 的新 LlmUsage 对象。
 * 对象字段可缺失（不等于 0），存在的计数必须是非负安全整数；非法对象或计数抛 ResponseError。
 * 本函数不保存状态、不做去重；去重由拥有整次请求状态的 OpenCodeGoClient 负责。
 */
function parseStreamUsage(value: unknown): LlmUsage {
  // 1. usage-only 的 null/数组等不是有效统计；普通中间帧的 null 由调用方在进入这里前忽略。
  if (!isRecord(value)) throw new ResponseError("流式 usage 必须是对象。");
  const usage: LlmUsage = {};

  // 2. 两种帧共用固定映射顺序，使等值统计不受外部 JSON 字段顺序影响。
  // as const 保留精确字段名，让 usage[target] 只能写入这两个内部统计属性。
  for (const [source, target] of [
    ["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"],
  ] as const) {
    const count = value[source];
    if (count !== undefined) {
      // 缺失字段不赋值；存在时不接受负数、小数、字符串或超出精确整数范围的数值。
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        throw new ResponseError("流式 token 用量必须是非负安全整数。");
      }
      usage[target] = count;
    }
  }
  return usage;
}

/**
 * 将一个完整 SSE data JSON 转成有序业务事件，由客户端逐帧调用。
 * 输入尚不可信；先区分普通消息帧与空 choices 的统计帧，再验证对应字段并产出事件。
 * 不拼参数、不执行工具；非法外层字段和 length 抛 ResponseError，不回显原始内容。
 * 去重 usage 以及 message_end 的前后顺序由每请求客户端状态检查。
 */
export function parseStreamChunk(data: string): LlmStreamEvent[] {
  // 1. SSE 层只保证拿到一份完整 data 文本，不保证它是合法 JSON 或模型响应。
  // JSON.parse 的结果保持 unknown，后续逐层确认对象形状，不能靠 as 断言跳过验证。
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new ResponseError("流式响应不是合法 JSON。");
  }

  // 2. 先验证公共外层，再按 choices 是否为空分类。不能直接要求 choices[0].delta，
  // 因为服务在 finish 后、[DONE] 前可能用 {choices:[],usage:{...}} 单独上报统计。
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new ResponseError("流式响应需要 choices 数组。");
  }
  if (value.choices.length === 0) {
    // 空 choices 只有携带合法统计时才被接受；此分支不会伪造文本或 message_end。
    // 若整条流缺少真正的 message_end，外层客户端依然会在 [DONE]/EOF 时拒绝成功。
    if (value.usage === undefined) throw new ResponseError("空 choices 的流式响应需要 usage。");
    return [{ type: "usage", usage: parseStreamUsage(value.usage) }];
  }

  // 普通消息帧仍只处理第一条候选回答；有 usage 也不能掩盖 choice/delta 的形状错误。
  const choice = value.choices[0] as unknown;
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ResponseError("流式响应需要 choice 和 delta 对象。");
  }
  const delta = choice.delta;
  const reason = choice.finish_reason;

  // 中间帧的 finish_reason 可以缺失或为 null，表示尚未结束；有值时必须是字符串。
  // length 优先失败，不能因为同一帧恰好还带合法文字/参数就先交付可执行的内容。
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new ResponseError("流式 finish_reason 必须是字符串。");
  }
  if (reason === "length") throw new ResponseError("模型响应被截断，不执行工具。");

  // 3. 一帧可能同时包含文字、工具片段、停止原因和统计，因此返回事件数组而非单个事件。
  // 顺序为文字 → 工具 → 收尾 → 用量；这里只做转换，不在此累计完整回答。
  const events: LlmStreamEvent[] = [];
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== "string") throw new ResponseError("流式 content 必须是文本。");
    events.push({ type: "text_delta", text: delta.content });
  }

  // 4. 逐项验证工具片段的外层字段。index 必须可作为稳定的 Map 键；
  // ID/函数名/参数允许暂缺，因为一项调用可能分多帧到达，但已有值的类型必须正确。
  if (delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) throw new ResponseError("流式工具调用必须是数组。");
    for (const call of delta.tool_calls as unknown[]) {
      if (
        !isRecord(call) || typeof call.index !== "number" || !Number.isSafeInteger(call.index) || call.index < 0 ||
        (call.type !== undefined && call.type !== "function") ||
        (call.id !== undefined && typeof call.id !== "string") ||
        (call.function !== undefined && !isRecord(call.function))
      ) throw new ResponseError("流式工具调用字段非法。");

      // function 缺失时使用空对象，表示该片段没有提供名称/参数，不能伪造默认参数。
      // 此处只确认 arguments 是字符串；完整 JSON 和 path 结构要等 assembler 收尾再检查。
      const fn = isRecord(call.function) ? call.function : {};
      if (
        (fn.name !== undefined && typeof fn.name !== "string") ||
        (fn.arguments !== undefined && typeof fn.arguments !== "string")
      ) throw new ResponseError("流式工具名称或参数片段非法。");

      // 条件展开仅复制实际提供的字段。外部 function.arguments 改名为 argumentsDelta，
      // 提醒 core 这是待追加的片段，还不是完整 argumentsJson。
      events.push({
        type: "tool_call_delta", index: call.index,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        ...(typeof fn.arguments === "string" ? { argumentsDelta: fn.arguments } : {}),
      });
    }
  }

  // 5. 非 null 的字符串停止原因才产生 message_end；[DONE] 由上一层单独识别，
  // 不能用它替代这个逻辑结束事件，也不把 usage 塞进 message_end。
  if (typeof reason === "string") events.push({ type: "message_end", finishReason: reason });

  // 6. 用量与回答内容分开处理。忽略未知字段，所以 reasoning/thinking 不会出现在事件中。
  // SSE 的中间帧可用 null 表示统计尚未可用；它不是一份空用量对象。
  if (value.usage !== undefined && value.usage !== null) {
    // 与 usage-only 使用完全相同的字段校验与规范化，不在解析单帧时决定是否重复。
    events.push({ type: "usage", usage: parseStreamUsage(value.usage) });
  }
  return events;
}
