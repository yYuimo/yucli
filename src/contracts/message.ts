/**
 * contracts 层的共享消息格式，供 core 和模型 adapter 在边界上传递信息。
 * core 操作这里的 toolCalls/toolCallId，adapter 再转成服务端 tool_calls/tool_call_id。
 * interface/type 编译后被擦除；收到网络 JSON 时仍需检查字段，而不是直接断言为此类型。
 */
import type { ToolCall, ToolDefinition } from "./tool.js";

/**
 * 消息角色的字符串字面量联合，只允许这四种取值。
 * 这是角色取值集合，不是一个可 new 的类；具体消息还要用下面的接口约束字段。
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * 用户输入或系统规则组成的文本消息，用在模型请求的 messages 中。
 * AgentLoop 用 prompt 创建 user 消息；当前 CLI 不自动创建 system 消息。
 * 由 core 构造、HTTP adapter 序列化；本接口只定义形状，不会自行发送消息。
 */
export interface TextMessage {
  /** user 表示用户提问，system 表示系统规则；这里只允许这两种角色。 */
  role: "system" | "user";

  /** 模型实际读取的文字；构造初始 user 消息时保留 prompt 原文。 */
  content: string;
}

/**
 * 表示模型说了什么、请求执行什么工具；既可出现在本轮响应，也可追加到后续请求历史。
 * adapter 从服务端响应中构造，AgentLoop 决定输出最终文本还是继续执行工具。
 * 有 toolCalls 时优先执行工具；即使同时有文字，也不能直接作为本轮最终回答。
 * content 和 toolCalls 都是可选字段，但类型本身不能保证“非空文本或合法调用至少有一项”，
 * 所以 adapter/core 仍需运行时校验；两者都没有不是合法模型响应。
 */
export interface AssistantMessage {
  /** 固定角色，便于用 message.role 区分它与 user/tool 消息。 */
  role: "assistant";

  /** 可省略的模型文字；外部 content:null 会被 adapter 规范化为空字符串。 */
  content?: string;

  /** 可选的有序调用列表；readonly 禁止通过该数组增删元素，不深度冻结调用对象。 */
  toolCalls?: readonly ToolCall[];
}

/**
 * 放进模型历史的工具结果消息，用来回答之前的某项 assistant 工具调用。
 * AgentLoop 根据 ToolResult 构造；adapter 把 toolCallId 转成服务端 tool_call_id。
 * 它与 ToolResult 不同：这里只描述模型要看到的消息，没有本地 ok 状态。
 */
export interface ToolMessage {
  /** 表示这条文字来自工具执行，不是用户发言或模型回答。 */
  role: "tool";

  /** 必须沿用对应 ToolCall.id，保证模型能区分同一批中不同工具的结果。 */
  toolCallId: string;

  /** 可选本地工具名，供调试识别；当前 adapter 不把此字段发给服务端。 */
  name?: string;

  /** 成功时为文件原文，失败时为安全错误摘要；空文件允许空字符串。 */
  content: string;
}

/**
 * 一条历史消息的所有可能形状，不是把三个接口的字段合并到同一个对象。
 * 它是判别联合：检查 role 后，TS 会收窄到对应接口，例如 tool 分支才有 toolCallId。
 * core 的 messages 数组使用此类型，因此可以按顺序保存不同来源的消息。
 */
export type Message = TextMessage | AssistantMessage | ToolMessage;

/**
 * 一次模型调用所需的内部输入，AgentLoop 或 runPrompt 创建后传给 LlmClient.complete。
 * adapter 将其映射到 HTTP JSON；API key、超时等连接配置不属于模型消息，另由构造参数提供。
 * 每轮由调用方提供当前完整历史，接口本身不会自动保存上一轮内容。
 */
export interface LlmRequest {
  /** 提供方使用的模型标识；CLI 加载配置时缺省为 deepseek-v4-flash，接口本身不设默认值。 */
  model: string;

  /** 本次模型可见的有序历史，顺序应保留 user → assistant 调用 → tool 结果。 */
  messages: Message[];

  /** 可选的能力声明，告诉模型允许请求哪些工具；缺失/空数组时 HTTP body 省略 tools。 */
  tools?: readonly ToolDefinition[];
}

/**
 * 一次模型请求的可选 token 用量，由 adapter 从服务端 usage 转换，供调用方统计。
 * token 是模型计量单位，不等于字符数；当前 CLI 不打印它，也不据此执行预算控制。
 * 字段存在时需校验为非负安全整数；缺失表示未提供统计，不能按 0 理解。
 */
export interface LlmUsage {
  /** 来自 usage.prompt_tokens，表示本次输入消耗量，包括本次发送的历史等。 */
  inputTokens?: number;

  /** 来自 usage.completion_tokens，表示服务端报告的本次输出消耗量。 */
  outputTokens?: number;
}

/**
 * LlmClient.complete 成功完成一次模型调用后给 core 的结果，不等同于整个循环已结束。
 * adapter 只返回契约内的 assistant 消息及可选元数据，不暴露完整 HTTP 响应。
 * message 还可能要求执行工具；AgentLoop 处理后才会形成最终 AgentLoopResult。
 */
export interface LlmResponse {
  /** 本轮模型文字及工具调用；只允许 assistant，不能把 tool 结果冒充模型回答。 */
  message: AssistantMessage;

  /**
   * 来自 finish_reason 的停止原因；只用于本轮判断，不放进历史消息。
   * 例如 stop/tool_calls；OpenCode adapter 遇 length 直接失败，core 也有防御性检查。
   */
  finishReason?: string;

  /** 可选的本轮 token 统计；缺失时调用方仍可以处理正常模型结果。 */
  usage?: LlmUsage;
}
