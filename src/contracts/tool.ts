/** 工具契约只描述数据和能力，不依赖文件系统或具体模型。 */
export interface ToolCall {
  // 模型生成的调用 ID，tool 结果必须沿用它；同一批内不允许重复。
  id: string;
  name: string;

  // 仍是 JSON 文本，尚未验证；不能直接把它当成可安全访问的参数对象。
  argumentsJson: string;
}

/** 当前工具只需字符串字段的对象 schema；后续按实际需求扩展。 */
export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: "string"; description?: string }>;
  required: readonly string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: "read_file";
  description: string;

  // 向模型说明应生成什么参数；本地执行前仍必须运行时校验，schema 不能保证模型遵守。
  parameters: JsonSchema;
}

/** 工具名与 ID 留在本地结果中，content 是可传回模型的成功文本或安全错误。 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
}

export interface Tool {
  definition: ToolDefinition;

  /**
   * 执行某个具体工具的工作；RegisteredTools 通过此接口调用适配器，例如 ReadFileTool。
   * @param args 注册表从 argumentsJson 解析得到的对象，工具仍需检查其字段和业务边界。
   * @param signal 可选的命令级取消信号，由实现检查并传给可取消的底层操作。
   * @returns 成功文本或 ok:false 的安全错误摘要；结果此时还不含调用 ID 和名称。
   * 普通业务失败作为结果返回；取消和不可恢复异常拒绝 Promise，交给注册表及循环处理。
   * 具体副作用由实现决定，阶段 02 只提供文件读取，不允许写入。
   */
  execute(args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; content: string }>;
}

export interface ToolRegistry {
  /**
   * 列出模型可使用的工具名称、功能说明和参数 schema，由 AgentLoop 在循环开始时读取。
   * @returns 有序的只读工具定义数组；没有工具时返回空数组，不执行其中的工具。
   * 本接口不负责生成提供方 tools 字段，HTTP 格式转换由 adapter 完成。
   */
  definitions(): readonly ToolDefinition[];

  /**
   * 根据模型提出的名称执行一项调用，将执行结果与原始 ID 配对，供 AgentLoop 追加 tool 消息。
   * @param call 内部调用结构，包括 id、name 和尚需校验的 argumentsJson。
   * @param signal 可选取消信号，应传给具体工具，并在结果交回前检查。
   * @returns 含 toolCallId、name、ok、content 的 ToolResult；未知名称返回 ok:false。
   * 结构非法和不可恢复内部异常抛稳定循环错误；取消抛 AbortError，不作为普通错误回传模型。
   */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}
