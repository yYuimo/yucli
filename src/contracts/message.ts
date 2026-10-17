export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: Message[];
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResponse {
  message: { role: "assistant"; content: string };
  usage?: LlmUsage;
}
