import type { LlmClient } from "../contracts/llm-client.js";
import type { LlmResponse } from "../contracts/message.js";

/**
 * 把用户的一句话包装成模型请求，调用一次客户端，并把模型响应交回调用方。
 * 保留阶段 01 的单次调用入口，供测试或无需工具的调用方使用；阶段 02 CLI 使用 agentLoop。
 * 本阶段请求只有一条 user 消息，不保留历史，也不在这里输出回答。
 *
 * @param client 由调用方注入的客户端；本函数只要求它具有 complete 能力。
 * @param model 本次使用的模型标识，来自配置。
 * @param prompt 用户输入原文；调用方应先检查非空白，本函数不会 trim 或再次校验。
 * @param signal 可选取消信号，原样传给客户端。
 * @returns 客户端的 Promise；正常文本问答得到 assistant 文本及可选用量。
 * 若客户端返回工具调用，也原样返回，不在这里执行工具或继续请求下一轮。
 * 客户端失败时，返回的 Promise 保留其拒绝原因，交给调用方捕获。
 */
export function runPrompt(
  client: Pick<LlmClient, "complete">,
  model: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<LlmResponse> {
  // 把用户原文放入一条 user 消息，本阶段不保存历史、不添加 system prompt。
  // 直接返回 complete 的 Promise：成功结果或拒绝原因会原样交给上层 await。
  // 这里没有额外异步步骤或清理逻辑，因此无需再写 async/await 或 try/catch。
  return client.complete(
    {
      model,
      messages: [{ role: "user", content: prompt }],
    },
    signal,
  );
}
