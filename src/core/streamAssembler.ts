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
  // text 累计本响应的文字；ended 表示逻辑收尾，不能用“当前收到了文字”代替它。
  private text = "";
  private ended = false;

  // Map 的键是调用 index：例如 index=0/1 的参数片段交错到达时，各自更新不同对象。
  // readonly 只禁止替换 this.calls，仍允许 set 更新这个 Map 中的临时拼装状态。
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
    // 1. 统计不是消息内容，且允许出现在 message_end 后，因此先独立忽略 usage，
    // 再检查 ended；否则会把合法的尾部统计误判为“回答结束后又追加文字”。
    if (event.type === "usage") return;
    if (this.ended) throw new ResponseError("模型消息已经结束，不能继续追加内容。");

    // 2. 文本按事件到达顺序拼接，保留空格/换行；不要逐片 trim，
    // 否则 "hello " + "world" 会错误变成 "helloworld"。
    if (event.type === "text_delta") {
      this.text += event.text;
      return;
    }

    // 3. 收尾时才判断“完整意图”是否合法。length 即使恰好留下合法 JSON 也拒绝。
    // finish 在此做首次整批校验；调用方仍须等 generator 正常结束后才能执行工具。
    if (event.type === "message_end") {
      if (event.finishReason === "length") throw new ResponseError("模型响应被截断，不执行工具。");
      this.ended = true;
      this.finish();
      return;
    }

    // 4. 前面的分支都已 return，TS 根据 type 把 event 收窄为 tool_call_delta。
    // 再检查运行时 index，避免负数、小数或不安全整数被当作有效工具身份。
    if (!Number.isSafeInteger(event.index) || event.index < 0) {
      throw new ResponseError("工具调用 index 必须为非负安全整数。");
    }

    // 先取同一 index 已有的状态；首次出现则建立空状态，允许 ID/名称稍后到达。
    // 缺字段暂时不等于错误，message_end 时仍未补齐才会被 validateToolBatch 拒绝。
    const call = this.calls.get(event.index) ?? { index: event.index, id: "", name: "", argumentsJson: "" };

    // 5. ID/名称是身份字段，不是文字片段：允许补齐或重复相同值，不允许中途改名。
    // as const 让 field 保持 "id" | "name"，因此 call[field] 只能访问这两个字符串字段。
    for (const field of ["id", "name"] as const) {
      const value = event[field];
      if (value) {
        if (call[field] && call[field] !== value) {
          throw new AgentLoopError("protocol_error", "同一工具序号的 ID 或名称发生变化。");
        }
        call[field] = value;
      }
    }

    // 6. 只有参数采用追加策略。例如 '{"path":' 和 '"README.md"}' 拼成一个 JSON。
    // 片段只追加到本 index，不能与其他工具共用一个全局 arguments 字符串。
    call.argumentsJson += event.argumentsDelta ?? "";
    this.calls.set(event.index, call);

    // size 是不同调用的数量，而不是 delta 数量；同一工具分成十片仍只算一项。
    if (this.calls.size > this.maxCalls) throw new AgentLoopError("protocol_error", "工具调用批次数量超限。");
  }

  /**
   * 返回已经完整校验的 assistant 消息，由 turn 在整条 generator 成功结束后调用。
   * 按 index 排序，再复用阶段 02 的整批参数/ID 校验；无调用时要求非空白文本。
   * 缺 message_end 抛 ResponseError；非法工具批次抛 AgentLoopError，均不会执行任何工具。
   * 返回新对象，不包含 usage/finishReason；不会修改 REPL 历史或输出屏幕文字。
   */
  finish(): AssistantMessage {
    // 流读完不代表模型逻辑消息完整；例如只有参数片段或只有 [DONE] 都不能成功。
    if (!this.ended) throw new ResponseError("模型响应缺少 message end。");

    // Map 保持的是首次到达顺序，工具真正的执行顺序则由 index 决定。
    // 先拷贝并排序，再去掉仅用于拼装的 index，得到阶段 02 也认识的 ToolCall 对象。
    const calls = [...this.calls.values()]
      .sort((a, b) => a.index - b.index)
      .map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson }));

    // 统一检查整批数量、唯一 ID、名称和每项参数结构；任何一项失败，整批都不会交付。
    validateToolBatch(calls, this.maxCalls);

    // 有工具时允许没有文字；无工具时必须有真正答案。trim 只用于检查，不改写原文。
    if (!calls.length && !this.text.trim()) throw new ResponseError("模型未返回非空白文本或工具调用。");

    // 条件展开在没有调用时省略 toolCalls；usage、ended 和 Map 不进入模型历史。
    return { role: "assistant", content: this.text, ...(calls.length ? { toolCalls: calls } : {}) };
  }
}
