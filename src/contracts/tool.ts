/**
 * 模型提出的一项执行请求，adapter 从外部 tool_calls 转换而来，随后交给 core 预检。
 * 这只是“调用数据”，不是已经运行的工具或结果；ID、名称和参数结构都要在执行前检查。
 * 例如 {id:"call-1", name:"read_file", argumentsJson:'{"path":"README.md"}'}。
 */
export interface ToolCall {
  /** 模型生成的非空调用 ID；结果必须沿用，同一批内不允许重复。 */
  id: string;

  /** 非空工具名称；只有 read_file 被注册，未知名称作为可恢复执行错误回传。 */
  name: string;

  /** 参数原始 JSON 文本，尚未验证；必须先解析再校验，不能直接读取其 path 属性。 */
  argumentsJson: string;
}

/**
 * 向模型说明工具参数格式的 JSON Schema 子集，不是用来执行工具的参数值本身。
 * ReadFileTool.definition 创建它，adapter 随 tools 发送，帮助模型生成 {path:string}。
 * 本项目只表达“若干字符串属性的对象”，不声称支持完整 JSON Schema。
 * 该声明不自动验证任何数据，模型生成的参数仍由 core 和工具执行运行时检查。
 */
export interface JsonSchema {
  /** 固定要求参数顶层是对象，不能是数组、字符串或 null。 */
  type: "object";

  /**
   * 属性名到属性说明的字典；Record<string,T> 表示每个字符串键对应一个 T。
   * 这里属性值只能声明 type:string，description? 是给模型看的可选字段说明。
   */
  properties: Record<string, { type: "string"; description?: string }>;

  /** 必须出现的属性名列表，read_file 为 ["path"]；不是参数值列表。 */
  required: readonly string[];

  /** 固定为 false，声明只允许 properties 列出的字段，不接受 encoding 等额外参数。 */
  additionalProperties: false;
}

/**
 * 工具的公开说明书：模型通过它知道工具名、用途及参数要求。
 * 具体工具实例提供 definition，注册表收集后交给模型；不在这里放执行函数或文件根目录。
 * adapter 在 HTTP 层外包 {type:"function",function:definition}，本地接口保持提供方无关。
 */
export interface ToolDefinition {
  /** 当前阶段唯一注册名；固定字面量类型暂不允许任意工具名。 */
  name: "read_file";

  /** 给模型看的工具用途说明，例如读取工作区 UTF-8 文件且不修改内容。 */
  description: string;

  /** 参数结构说明；不是某次调用的实际参数，不能用它替代执行前校验。 */
  parameters: JsonSchema;
}

/**
 * 注册表完成一项调用后交给 AgentLoop 的结果，包含执行状态以及与请求配对的信息。
 * 具体工具只返回 {ok,content}，注册表补上 toolCallId/name；循环保留本地结果以便诊断。
 * 发回模型时转换为 ToolMessage，只传 ID 和 content，ok 不直接进入 HTTP 消息。
 */
export interface ToolResult {
  /** 原始 ToolCall.id，用于将执行结果绑定到提出该请求的模型调用。 */
  toolCallId: string;

  /** 调用中请求的工具名，未知工具也保留名称；不等于已注册且执行成功。 */
  name: string;

  /** true 表示工具成功，false 表示可恢复工具错误；取消和协议错误另走异常。 */
  ok: boolean;

  /** 成功为文件原文（可为空），失败为固定安全摘要；避免绝对路径、密钥和栈信息。 */
  content: string;
}

/**
 * 可执行工具的能力接口，既有公开定义，也有 execute 行为。
 * ReadFileTool 实现它；RegisteredTools 持有 Tool 实例并调用，不依赖具体文件工具类。
 * 与只描述数据的 ToolCall/ToolResult 不同，它描述对象必须具备的属性和方法；
 * 接口本身不会创建实例，运行时方法由实现对象提供。
 * 单个工具只认识自己的定义和实现，不感知注册表如何找到自己、结果如何配对，
 * 也不知道是否还有同类工具；“有哪些工具、这活派给谁”由 ToolRegistry 负责。
 */
export interface Tool {
  /** 供模型查看的工具说明；与 execute 实际接受的参数规则应保持一致。 */
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

/**
 * core 使用的“工具集合”能力：一方面向模型公开定义，一方面按名称分派调用。
 * bootstrap 创建 RegisteredTools 并注入 AgentLoop，循环只需要这个接口。
 * 它不等于某个 Tool，也不负责决定循环何时结束；一次 execute 只处理一项调用。
 * 接口描述方法契约，具体工具集合与实现状态由 RegisteredTools 保存。
 * 与 Tool 的分工：调用链是 AgentLoop → ToolRegistry → Tool；查找工具、解析参数原文、
 * 结果配对 ID 这些分派杂活都在这一层完成，具体工具只接收已解析参数并执行。
 */
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
   * @param signal 可选取消信号，应传给具体工具；完整合法输出已交付后不以新取消覆盖结果。
   * @returns 含 toolCallId、name、ok、content 的 ToolResult；未知名称返回 ok:false。
   * 结构非法抛 AgentLoopError(protocol_error)，不可恢复内部异常抛 ToolExecutionError；
   * 真正取消抛 AbortError，保存故障原样穿透，均不作为普通工具失败回传模型。
   */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * 工具实现/注册表无法交付合法结果时的安全业务异常，由执行边界创建、core/后续协调方识别。
 * 区别于模型协议错误和正常 ok:false，也不是存储故障；可映射为 tool/tool_execution_failed。
 */
export class ToolExecutionError extends Error {
  override name = "ToolExecutionError";
  /** 后续协调方映射安全错误时使用的工具业务分类。 */
  readonly category = "tool";
  /** 区别于 protocol_error 与正常 ok:false 的稳定内部执行错误码。 */
  readonly code = "tool_execution_failed";

  /** 固定安全摘要，不接受原始异常/路径/堆栈输入；调用后无 I/O 或保存副作用。 */
  constructor() {
    super("工具执行发生内部错误，本次命令已停止。");
  }
}
