/**
 * contracts 层的共享消息格式，供 core 和模型 adapter 在边界上传递信息。
 * core 操作这里的 toolCalls/toolCallId，adapter 再转成服务端 tool_calls/tool_call_id。
 * interface/type 编译后被擦除；收到网络 JSON 时仍需检查字段，而不是直接断言为此类型。
 */
import type { ToolCall, ToolDefinition } from "./tool.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 用户或系统提供的纯文本；阶段 02 默认只创建 user 消息。 */
export interface TextMessage {
  role: "system" | "user";
  content: string;
}

/** 模型可同时返回文字和工具调用；有调用时优先执行工具，再请求最终回答。 */
export interface AssistantMessage {
  role: "assistant";

  // 文本可以缺省，但必须与非空 toolCalls 至少有一项；有效性由运行时校验保证。
  content?: string;
  toolCalls?: readonly ToolCall[];
}

/** 工具结果通过调用 ID 配对；name 只供本地使用，不发送给服务端。 */
export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  name?: string;
  content: string;
}

// 判别联合：检查 message.role 后，TS 就知道该分支可以读取哪些字段。
export type Message = TextMessage | AssistantMessage | ToolMessage;

/** 模型调用输入；无工具的调用方仍可只传 model 和 messages。 */
export interface LlmRequest {
  model: string;
  messages: Message[];
  tools?: readonly ToolDefinition[];
}

/** 可选统计；字段缺失表示未提供，而非用量为零。 */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 校验后的模型输出；finishReason 是本轮元数据，不放进消息历史发送。 */
export interface LlmResponse {
  message: AssistantMessage;

  // 例如 stop、tool_calls、length；length 会在 adapter 直接失败，不返回成功结果。
  finishReason?: string;
  usage?: LlmUsage;
}
