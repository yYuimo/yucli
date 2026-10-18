import type { LlmClient } from "../contracts/llm-client.js";
import type { LlmResponse } from "../contracts/message.js";

/**
 * 把用户的一句话包装成模型请求，调用一次客户端，并把回答交回 CLI。
 * CLI 在参数和配置检查通过后调用它；这是 core 层的单次问答入口。
 * 本阶段请求只有一条 user 消息，不保留历史，也不在这里输出回答。
 *
 * @param client 由 CLI 创建并注入的客户端；本函数只要求它具有 complete 能力。
 * @param model 本次使用的模型标识，来自配置。
 * @param prompt 用户输入原文，CLI 已确认它不是空白文本。
 * @param signal 可选取消信号，原样传给客户端。
 * @returns 客户端的 Promise；成功后得到 assistant 文本及可选 token 用量。
 * 客户端失败时，返回的 Promise 保留其拒绝原因，交给 CLI 捕获。
 */
export function runPrompt(
  client: LlmClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  // 把用户原文放入一条 user 消息，本阶段不保存历史、不添加 system prompt。
  // 直接返回 complete 的 Promise：成功结果或拒绝原因会原样交给上层 await。
  // 这里没有额外异步步骤或清理逻辑，因此无需再写 async/await 或 try/catch。
  return client.complete({ model, messages: [{ role: "user", content: prompt }] }, signal);
}
