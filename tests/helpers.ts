import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";

export async function startServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

export function completion(content = "你好！") {
  return { choices: [{ message: { role: "assistant", content, reasoning_content: "不应显示的推理" } }] };
}

/** 构造本地服务的工具调用响应；arguments 保持 JSON 字符串，供 adapter/core 验证。 */
export function toolCompletion(
  calls: { id: string; name?: string; argumentsJson?: string }[] = [{ id: "call-1" }],
  finishReason = "tool_calls",
) {
  return {
    choices: [{
      finish_reason: finishReason,
      message: {
        role: "assistant", content: null,
        tool_calls: calls.map((call) => ({
          id: call.id, type: "function",
          function: { name: call.name ?? "read_file", arguments: call.argumentsJson ?? '{"path":"README.md"}' },
        })),
      },
    }],
  };
}

/** SSE 帧可以先编码再按任意字节切块，用于真实检验 decoder 的跨 chunk 行为。 */
export function sseFrame(value: unknown, crlf = false): string {
  const end = crlf ? "\r\n" : "\n";
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}${end}${end}`;
}

export function streamChunk(delta: object = {}, finishReason: string | null = null, usage?: object) {
  return { choices: [{ delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

export function completionSse(value: ReturnType<typeof completion> | ReturnType<typeof toolCompletion>) {
  const choice = value.choices[0]!;
  const message = choice.message;
  const delta = { ...message, ...("tool_calls" in message ? {
    tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
  } : {}) };
  return sseFrame(streamChunk(delta, "finish_reason" in choice ? choice.finish_reason : "stop")) + sseFrame("[DONE]");
}

export async function writeSse(
  response: import("node:http").ServerResponse,
  blocks: readonly (string | Uint8Array)[],
  intervalMs = 0,
) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const block of blocks) {
    if (response.destroyed) return;
    response.write(block);
    if (intervalMs) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!response.destroyed) response.end();
}
