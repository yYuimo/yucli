import { AbortError, AgentLoopError } from "../contracts/llm-client.js";
import type { Tool, ToolCall, ToolDefinition, ToolRegistry, ToolResult } from "../contracts/tool.js";

/**
 * 把模型生成的参数 JSON 文本转换成 read_file 可以接收的参数对象。
 * validateToolBatch 用它预检整批参数；RegisteredTools.execute 在分派前再次调用。
 * 先解析 JSON，再确认对象恰好只有一个字符串 path；类型断言本身不提供这种运行时保证。
 *
 * @param argumentsJson 模型原始参数字符串，例如 '{"path":"README.md"}'。
 * @returns 新的 {path} 对象；只保证结构合法，不保证文件存在或路径位于工作区。
 * @throws AgentLoopError(protocol_error) JSON 无效、path 缺失/类型错误或存在额外字段。
 * 空白和越界路径在文件工具中作为可恢复错误处理；这里不读文件、不执行工具，不回显参数。
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
 * 在执行前验证整批调用，保证不会执行到中途才发现后面某项的参数或 ID 非法。
 * AgentLoop 对整个响应调用它；注册表单独执行时也用它检查一项调用。
 * 依次检查数组和数量、每个非空 ID/名称、同批 ID 唯一性，以及每项参数 JSON/字段。
 *
 * @param calls 已转成内部 ToolCall 的调用列表；即使 TS 声明正确也要检查实际数据。
 * @param maxCalls 本次允许的批次大小；循环默认传 4，单项分派传 1。
 * @returns 无返回值；正常返回表示整个批次通过结构检查，空数组也合法。
 * @throws AgentLoopError(protocol_error) 任一调用非法或数量超限；一个工具都不执行。
 * 这里只检查结构，不检查工具是否注册或文件是否可读；不修改 calls 和参数原文。
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

/**
 * ToolRegistry 的默认实现：持有本次命令的工具集合，向模型公开定义并按名称分派调用。
 * 与单个 Tool 的分工：查找、参数解析（argumentsJson → 已校验对象）和结果配对都在这里完成，
 * 具体工具只负责执行已解析的参数。工具实例由 bootstrap 注入，本类不依赖文件系统，
 * 也不认识任何具体工具类。
 */
export class RegisteredTools implements ToolRegistry {
  /**
   * 建立本次命令的工具集合，供模型查询定义和循环按名称分派。
   * bootstrap 将已创建的 ReadFileTool 实例传入；本构造器不负责创建具体工具。
   *
   * @param tools 可执行的工具实例数组；保存数组副本，外部增删原数组不会改变注册顺序。
   * 构造后得到注册表实例；工具对象本身共享，不做深拷贝，不执行工具或读取文件。
   */
  constructor(private readonly tools: readonly Tool[]) {
    this.tools = [...tools];
  }

  /**
   * 提取已注册工具的说明和参数 schema，让模型知道可以调用哪些能力。
   * AgentLoop 在循环开始时调用一次，将同一组定义传给后续各轮模型请求。
   *
   * @returns 按注册顺序组成的新数组；无注册工具时返回空数组，adapter 随后省略 tools 字段。
   * 定义对象取自工具实例；readonly 是编译期的只读数组约束，不是深度冻结。
   * 本方法不执行工具、不读取文件，也不发起模型请求。
   */
  definitions(): readonly ToolDefinition[] {
    return this.tools.map((tool) => tool.definition);
  }

  /**
   * 将一个模型调用分派给同名工具，并把执行结果包装成可配对的 ToolResult。
   * AgentLoop 在全批预检通过后按顺序调用；这里仍复核单项结构，避免独立使用时跳过校验。
   * 执行顺序是校验参数 → 检查取消 → 查找工具 → 执行 → 附加调用 ID/名称。
   *
   * @param call 一项模型调用，包含原始 ID、工具名和参数 JSON 文本。
   * @param signal 可选取消信号，继续传给具体工具；工具结束后再次检查取消。
   * @returns 配对的 ToolResult；未知名称及普通文件错误返回 ok:false，供模型继续回答。
   * @throws AgentLoopError 参数/结构非法，或工具抛出不可恢复内部异常。
   * @throws AbortError 取消时拒绝 Promise，不把取消转换成普通文件错误。
   * 只把安全摘要交给上层；文件读取发生在具体工具中，本注册表不接触 Node 文件 API。
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
