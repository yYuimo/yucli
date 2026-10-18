import type { LlmClient } from "../contracts/llm-client.js";
import type { LlmResponse } from "../contracts/message.js";

/**
 * core 层的一次提问流程，由 bootstrap 注入客户端和配置中的模型名。
 * 这里只构造领域消息，不读取环境变量，也不处理 HTTP、打印或退出进程。
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
