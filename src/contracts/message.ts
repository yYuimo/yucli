/**
 * contracts 层：core 与模型 adapter 共同使用的数据格式。
 * interface/type 用于编译期检查，编译成 JavaScript 后会被擦除；
 * 收到网络 JSON 时仍须执行运行时校验，不能只给它标注一个接口类型。
 */

// 字符串字面量的联合类型：role 只能是这三个字符串之一。
export type MessageRole = "system" | "user" | "assistant";

/** 一条纯文本消息；当前阶段尚无 tool 消息或多模态内容。 */
export interface Message {
  role: MessageRole;
  content: string;
}

/** 一次调用的输入；Message[] 表示按顺序排列的消息数组。 */
export interface LlmRequest {
  model: string;
  messages: Message[];
}

// 字段后的 ? 表示可以不提供。没有用量统计不等于 token 用量为 0。
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** adapter 校验并转换后的输出，core 无须了解服务端的 choices 结构。 */
export interface LlmResponse {
  // 内联对象类型；这里 role 比 MessageRole 更窄，只允许 assistant。
  message: { role: "assistant"; content: string };
  usage?: LlmUsage;
}
