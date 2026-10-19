import { AbortError, AgentLoopError } from "../contracts/llm-client.js";
import type { Tool, ToolCall, ToolDefinition, ToolRegistry, ToolResult } from "../contracts/tool.js";

/**
 * 将模型的参数原文解析成 read_file 输入；批次预检和注册表均调用它。
 * 返回恰好只有字符串 path 的对象；空白/越界路径留给工具作为可恢复错误处理。
 * JSON 或字段结构非法时抛协议错误，不把模型原文写进错误信息。
 */
export function parseToolArguments(argumentsJson: string): { path: string } {
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new AgentLoopError("protocol_error", "工具参数不是合法 JSON。");
  }

  if (
    typeof args !== "object" || args === null || Array.isArray(args) ||
    Object.keys(args).length !== 1 || !("path" in args) || typeof args.path !== "string"
  ) {
    throw new AgentLoopError("protocol_error", "工具参数必须恰好包含字符串 path。");
  }

  return { path: args.path };
}

/**
 * 在任何工具执行前校验整个批次，防止前半批成功后才发现后半批结构错误。
 * AgentLoop 调用；合法时无返回值，非法时抛 AgentLoopError，尚无工具副作用。
 * 即使来自非 HTTP 的客户端也必须遵循同一 ID、参数和批次上限规则。
 */
export function validateToolBatch(calls: readonly ToolCall[], maxCalls: number): void {
  if (!Array.isArray(calls) || calls.length > maxCalls) {
    throw new AgentLoopError("protocol_error", "工具调用批次数量非法。");
  }

  const ids = new Set<string>();
  for (const call of calls) {
    if (
      !call || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id) ||
      typeof call.name !== "string" || !call.name.trim() || typeof call.argumentsJson !== "string"
    ) {
      throw new AgentLoopError("protocol_error", "工具调用结构或调用 ID 非法。");
    }

    ids.add(call.id);
    parseToolArguments(call.argumentsJson);
  }
}

/** core 中的名称分派器；具体 Tool 实例由 bootstrap 注入，没有文件系统依赖。 */
export class RegisteredTools implements ToolRegistry {
  /** 保存本次命令可调用的工具；复制数组，避免调用方增删影响注册顺序。 */
  constructor(private readonly tools: readonly Tool[]) {
    this.tools = [...tools];
  }

  /** 返回注册顺序的模型工具定义，供 AgentLoop 每轮传给客户端。 */
  definitions(): readonly ToolDefinition[] {
    return this.tools.map((tool) => tool.definition);
  }

  /**
   * 校验一次调用并执行对应工具，将结果与 ID/名称配对返回给 AgentLoop。
   * 未知名称返回 ok:false；取消和内部异常结束循环，不把底层异常发给模型。
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    validateToolBatch([call], 1);
    if (signal?.aborted) throw new AbortError("工具调用已取消。");

    const tool = this.tools.find((candidate) => candidate.definition.name === call.name);
    if (!tool) {
      return {
        toolCallId: call.id, name: call.name, ok: false,
        content: "[unknown_tool] 未注册此工具。",
      };
    }

    try {
      const output = await tool.execute(parseToolArguments(call.argumentsJson), signal);
      if (signal?.aborted) throw new AbortError("工具调用已取消。");

      return { toolCallId: call.id, name: call.name, ...output };
    } catch (error) {
      if (signal?.aborted || error instanceof AbortError) throw new AbortError("工具调用已取消。");
      throw new AgentLoopError("protocol_error", "工具执行发生内部错误，本次命令已停止。");
    }
  }
}
