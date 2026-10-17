import type { LlmClient, LlmResponse } from "../llm/types.js";

export function runPrompt(
  client: LlmClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  return client.complete({ model, messages: [{ role: "user", content: prompt }] }, signal);
}
