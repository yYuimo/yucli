import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/loadConfig.js";
import { AbortError, RequestError, ResponseError } from "../errors.js";
import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown): LlmResponse {
  const choice = isRecord(value) && Array.isArray(value.choices) ? value.choices[0] as unknown : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  if (!isRecord(message) || message.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) {
    throw new ResponseError("响应解析失败：需要非空的 choices[0].message assistant 文本。");
  }
  const response: LlmResponse = { message: { role: "assistant", content: message.content } };
  if (isRecord(value) && value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new ResponseError("响应解析失败：usage 必须是对象。");
    const usage: LlmUsage = {};
    for (const [source, target] of [["prompt_tokens", "inputTokens"], ["completion_tokens", "outputTokens"]] as const) {
      const count = value.usage[source];
      if (count !== undefined) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new ResponseError("响应解析失败：token 用量必须是非负整数。");
        }
        usage[target] = count;
      }
    }
    response.usage = usage;
  }
  return response;
}

// 诊断最多读取 512 字节，不使用 response.text() 读完整错误体。
async function readErrorSummary(response: Response, apiKey: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const bytes = new Uint8Array(512);
  let length = 0;
  try {
    while (length < bytes.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, bytes.length - length);
      bytes.set(part, length);
      length += part.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  // stream 模式丢弃截断处未完成的 UTF-8 字符。
  let summary = new TextDecoder().decode(bytes.subarray(0, length), { stream: true });
  summary = summary.split(apiKey).join("[REDACTED]");
  // 错误体刚好在密钥中间截断时，也不能输出密钥前缀。
  for (let size = Math.min(apiKey.length - 1, summary.length); size > 0; size--) {
    if (summary.endsWith(apiKey.slice(0, size))) {
      summary = summary.slice(0, -size) + "[REDACTED]";
      break;
    }
  }
  summary = summary.replace(/authorization\s*[:=][^\r\n]*/giu, "[REDACTED]")
    .replace(/bearer\s+[^\s"',}]+/giu, "[REDACTED]")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return new TextDecoder().decode(Buffer.from(summary).subarray(0, 512), { stream: true });
}

export class OpenCodeGoClient implements LlmClient {
  constructor(private readonly config: Pick<RuntimeConfig, "apiKey" | "baseUrl" | "timeoutMs">) {}

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const controller = new AbortController();
    let abortKind: "timeout" | "caller" | undefined;
    const abort = (kind: "timeout" | "caller") => {
      if (controller.signal.aborted) return;
      abortKind = kind;
      controller.abort();
    };
    const onAbort = () => abort("caller");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => abort("timeout"), this.config.timeoutMs);
    let status: number | undefined;

    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "x-opencode-session": randomUUID(),
        },
        body: JSON.stringify({ model: request.model, messages: request.messages, stream: false }),
        signal: controller.signal,
        redirect: "error",
      });
      status = response.status;
      if (!response.ok) {
        const summary = await readErrorSummary(response, this.config.apiKey);
        throw new RequestError("http", `模型请求失败（HTTP ${status}）${summary ? `：${summary}` : "。"}`, status, summary);
      }
      // 读取响应体也在同一个超时边界内；JSON 错误与传输中断分开处理。
      const body = await response.text();
      controller.signal.throwIfAborted();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        throw new ResponseError("响应解析失败：服务未返回有效 JSON。");
      }
      return parseResponse(parsed);
    } catch (error) {
      if (abortKind === "caller") throw new AbortError("模型请求已取消。");
      if (abortKind === "timeout") {
        throw new RequestError("timeout", `模型请求超时（${this.config.timeoutMs} ms）${status ? `，HTTP ${status}` : ""}。`, status);
      }
      if (error instanceof RequestError || error instanceof ResponseError) throw error;
      // 不转发底层异常，避免 URL、请求头或凭证进入 CLI。
      throw new RequestError("network", `模型请求网络失败${status ? `（读取响应体，HTTP ${status}）` : "（连接或发送阶段）"}。`, status);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
