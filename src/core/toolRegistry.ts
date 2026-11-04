/** core 层工具预检、名称分派与顺序事实交付；不操作存储路径，不持有全局历史。 */
import { AbortError, AgentLoopError } from "../contracts/llm-client.js";
import type { Tool, ToolCall, ToolDefinition, ToolRegistry, ToolResult } from "../contracts/tool.js";
import { ToolExecutionError } from "../contracts/tool.js";
import { PersistenceError } from "../contracts/session.js";
import type { ToolEnd, TurnExecutionContext } from "../contracts/session.js";

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
  // 1. JSON 语法合法与业务结构合法是两件事。先解析成 unknown，
  // 即使结果是 null、数组或数字，也必须经过下面的对象/字段检查才能使用。
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson) as unknown;
  } catch {
    throw new AgentLoopError("protocol_error", "工具参数不是合法 JSON。");
  }

  // 2. 按短路顺序先排除非对象/null/数组，再查看字段数量、path 是否存在及其类型。
  // “恰好一个字段”会拒绝额外参数；这里只检查字符串形状，不判断路径存在或是否越界。
  if (
    typeof args !== "object" || args === null || Array.isArray(args) ||
    Object.keys(args).length !== 1 || !("path" in args) || typeof args.path !== "string"
  ) {
    throw new AgentLoopError("protocol_error", "工具参数必须恰好包含字符串 path。");
  }

  // 3. 返回只含已验证字段的新对象，不把任意模型属性直接转交给文件工具。
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
  // 先拒绝整批形状/数量错误，避免只遍历并执行前几个“看起来合法”的调用。
  if (!Array.isArray(calls) || calls.length > maxCalls) {
    throw new AgentLoopError("protocol_error", "工具调用批次数量非法。");
  }

  // Set 只记录当前批次已见 ID，不是全会话去重；不同模型响应可各自带调用 ID。
  const ids = new Set<string>();
  for (const call of calls) {
    // 非空判断用 trim，但不改变原始 ID/名称；结果配对必须沿用模型给出的原值。
    if (
      !call || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id) ||
      typeof call.name !== "string" || !call.name.trim() || typeof call.argumentsJson !== "string"
    ) {
      throw new AgentLoopError("protocol_error", "工具调用结构或调用 ID 非法。");
    }

    ids.add(call.id);

    // 预检只解析/校验参数，不读文件、不调用 execute。后面任何一项失败时，
    // 前面已经校验通过的项也只是“通过检查”，整批仍然没有执行任何工具。
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
    // 复制数组以隔离注册顺序；工具实例本身仍共享，不深拷贝其方法、配置或工作区。
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
    // 只提取给模型看的说明，不能把 execute 函数或文件工具保存的根目录发给模型。
    return this.tools.map((tool) => tool.definition);
  }

  /**
   * 将一个模型调用分派给同名工具，并把执行结果包装成可配对的 ToolResult。
   * AgentLoop 在全批预检通过后按顺序调用；这里仍复核单项结构，避免独立使用时跳过校验。
   * 执行顺序是校验参数 → 检查取消 → 查找工具 → 执行 → 附加调用 ID/名称。
   *
   * @param call 一项模型调用，包含原始 ID、工具名和参数 JSON 文本。
   * @param signal 可选取消信号，继续传给具体工具；合法完整输出返回后不再用取消覆盖结果。
   * @returns 配对的 ToolResult；未知名称及普通文件错误返回 ok:false，供模型继续回答。
   * @throws AgentLoopError 参数/结构非法；ToolExecutionError 工具内部异常或输出不合法。
   * @throws AbortError 取消时拒绝 Promise，不把取消转换成普通文件错误。
   * 只把安全摘要交给上层；文件读取发生在具体工具中，本注册表不接触 Node 文件 API。
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    // 1. 即使循环刚做过整批检查，独立调用注册表也必须安全；这里复核当前一项。
    validateToolBatch([call], 1);
    if (signal?.aborted) throw new AbortError("工具调用已取消。");

    // 2. 名称匹配到的是已注册实例，不是动态加载模型指定的模块。
    // 非空但未知的名称属于可恢复执行错误，返回配对结果，让模型看到原因后继续回答。
    const tool = this.tools.find((candidate) => candidate.definition.name === call.name);
    if (!tool) {
      return {
        toolCallId: call.id, name: call.name, ok: false,
        content: "[unknown_tool] 未注册此工具。",
      };
    }

    try {
      // 3. 从原始 JSON 得到已校验的参数对象后才执行实际工具，并把同一取消信号继续传下去。
      // 工具可以在自己的读取检查点拒绝取消；一旦完整合法输出返回，结果必须先交付上层。
      const output = await tool.execute(parseToolArguments(call.argumentsJson), signal);
      if (!output || typeof output.ok !== "boolean" || typeof output.content !== "string") throw new ToolExecutionError();

      // 4. 工具只返回 ok/content；注册表补上调用 ID 和名称，形成可回传的 ToolResult。
      return { toolCallId: call.id, name: call.name, ok: output.ok, content: output.content };
    } catch (error) {
      // 取消必须继续向上抛，不能伪装成普通文件错误回传模型。
      // 其他未被工具转为 ok:false 的内部异常，以固定摘要停止循环，不泄露底层内容。
      if (error instanceof PersistenceError || error instanceof ToolExecutionError) throw error;
      if (error instanceof AbortError) throw error;
      if (signal?.aborted) throw new AbortError("工具调用已取消。");
      throw new ToolExecutionError();
    }
  }
}

/**
 * 复核完整批次并顺序交付工具事实，由流式 turn 和非流式循环在预算允许后调用。
 * registry 为名称分派器，calls 为原始调用顺序；signal 贯穿所有工具。
 * 可选 context 含本批 assistantId/事实 sink；每项在 start 确认后分派，正常结果确认后再检查取消。
 * 返回有序配对结果；取消/内部错误抛异常，不返回部分批次，但已交付事实不能被后续取消覆盖。
 * 实际文件读取由 registry 中的工具负责；本函数不修改 calls、不追加模型历史。
 */
export async function executeToolBatch(
  registry: ToolRegistry,
  calls: readonly ToolCall[],
  signal?: AbortSignal,
  context?: TurnExecutionContext & { assistantId: string },
): Promise<ToolResult[]> {
  // 独立调用执行器也必须整批合法；缩小额度的调用方已先按自己的限制校验，硬上限仍为 4。
  validateToolBatch(calls, 4);
  const results: ToolResult[] = [];

  // for...of 内 await 一个完成后才进入下一项；不能改用 map + Promise.all 并发执行。
  // 入口已经复核全批，此处只负责执行顺序与取消边界，不在执行途中决定批次是否合法。
  for (const call of calls) {
    if (signal?.aborted) throw new AbortError("工具循环已取消。");
    const ref = { assistantId: context?.assistantId ?? "", toolCallId: call.id, name: call.name };
    if (context) await context.facts.record({ type: "tool_start", turnId: context.turnId, call: ref });

    // start 的保存等待不能用业务 signal 中断；确认后若取消，明确证明注册表尚未进入。
    if (signal?.aborted) {
      if (context) await context.facts.record({
        type: "tool_end", turnId: context.turnId, call: ref,
        end: { outcome: "cancelled", error: { category: "cancellation", code: "cancelled_before_dispatch", message: "工具分派前已取消。" } },
      });
      throw new AbortError("工具分派前已取消。");
    }
    let result: ToolResult;
    try {
      const delivered = await registry.execute(call, signal);
      // 注入的注册表也需交付完整配对数据；只提取业务字段，不接受错误 ID 或非法结果形状。
      if (
        !delivered || delivered.toolCallId !== call.id || delivered.name !== call.name ||
        typeof delivered.ok !== "boolean" || typeof delivered.content !== "string"
      ) throw new ToolExecutionError();
      result = { toolCallId: delivered.toolCallId, name: delivered.name, ok: delivered.ok, content: delivered.content };
    } catch (error) {
      // 保存故障和模型协议/额度分类原样穿透；不能伪装成工具结束，或在故障 sink 上递归写入。
      if (error instanceof PersistenceError || error instanceof AgentLoopError) throw error;
      const business = error instanceof ToolExecutionError || error instanceof AbortError ? error
        : signal?.aborted ? new AbortError("工具调用已取消。") : new ToolExecutionError();
      const end: ToolEnd = business instanceof AbortError
        ? { outcome: "cancelled", error: { category: "cancellation", code: "user_interrupt", message: "工具调用已取消。" } }
        : { outcome: "failed", error: { category: "tool", code: "tool_execution_failed", message: business.message } };
      if (context) await context.facts.record({ type: "tool_end", turnId: context.turnId, call: ref, end });
      throw business;
    }

    // 保存结果在工具业务 catch 外：保存拒绝不能变成 tool_end，也不能被并发取消掩盖。
    if (context) await context.facts.record({ type: "tool_result", turnId: context.turnId, call: ref, result });
    results.push(result);
    if (signal?.aborted) throw new AbortError("工具循环已取消。");
  }

  // 只在整批执行完成时交付；中途异常会直接抛出，调用方拿不到部分成功数组。
  return results;
}
