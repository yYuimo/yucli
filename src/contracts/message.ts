/** contracts 层的消息格式；用 role 区分不同消息，编译期类型不能代替网络数据校验。 */
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
  finishReason?: string;
  usage?: LlmUsage;
}
