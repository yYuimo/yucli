import type { LlmClient } from "../contracts/llm-client.js";
import type { LlmResponse } from "../contracts/message.js";

export function runPrompt(
  client: LlmClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return client.complete({ model, messages: [{ role: "user", content: prompt }] }, signal);
}
