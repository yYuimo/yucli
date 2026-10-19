/** 工具契约只描述数据和能力，不依赖文件系统或具体模型。 */
export interface ToolCall {
  id: string;
  name: string;
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

  /** 执行已解析的参数，返回文本结果；可恢复错误返回 ok:false，取消则拒绝 Promise。 */
  execute(args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; content: string }>;
}

export interface ToolRegistry {
  /** 返回本次命令注册的工具定义，让模型知道可调用的能力。 */
  definitions(): readonly ToolDefinition[];

  /** 按名称分派一次调用，并为执行结果附上原始 ID；未知名称返回安全失败结果。 */
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}
