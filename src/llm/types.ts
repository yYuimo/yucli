import type { Message } from "../types/message.js";

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

export interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
