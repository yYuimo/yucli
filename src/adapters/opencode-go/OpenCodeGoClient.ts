/**
 * adapters 层：把 yucli 的模型契约转换为 OpenCode Go HTTP 协议。
 * 调用顺序：complete → fetch → 读取响应 → parseResponse → 返回领域响应。
 * 本模块负责网络资源和协议校验；不打印终端文本、不保存会话。
 */
import { randomUUID } from "node:crypto";
import { AbortError, RequestError, ResponseError } from "../../contracts/llm-client.js";
import type { LlmClient } from "../../contracts/llm-client.js";
import type { LlmRequest, LlmResponse, LlmUsage } from "../../contracts/message.js";

// 客户端只需要连接参数，不依赖 dotenv 或配置加载器；bootstrap 负责传入。
export interface OpenCodeGoClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * 判断一份尚未验证的数据能否作为普通对象继续检查属性。
 * parseResponse 在读取 JSON 的 choices、message、usage 前调用它，避免访问 null 等值。
 *
 * @param value 任意待检查值，可以是服务端返回的任意 JSON 数据。
 * @returns 非 null、非数组对象时为 true，其余为 false；不修改数据、不检查业务字段。
 *
 * unknown 表示“尚不知道是什么”，访问属性前必须检查。
 * value is Record<string, unknown> 是类型谓词：函数返回 true 后，
 * TS 才允许将 value 当作字符串键的对象使用；属性值仍是 unknown。
 * 这里排除 null（typeof null 也是 object）和数组，不代表已经验证业务字段。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把服务端 JSON 转换为 yucli 的 LlmResponse，确保上层拿到可用的模型回答。
 * complete 在 HTTP 成功且 JSON 语法解析成功后调用它。
 * 先检查 choices[0].message 是非空 assistant 文本，再校验并映射可选的 token 用量。
 *
 * @param value JSON.parse 得到的未验证数据；标为 unknown 强制逐项检查。
 * @returns 新的领域响应对象，保留回答原文，只提取约定字段，不返回 reasoning 或原始 JSON。
 * @throws ResponseError 必需字段缺失、类型错误、回答空白或用量非法时抛出。
 * 本函数不修改输入、不发请求、不输出日志。
 */
function parseResponse(value: unknown): LlmResponse {
  // 三元表达式“条件 ? 真时的值 : 假时的值”；先检查对象和数组，才尝试取第一项。
  // as unknown 不验证元素内容，只阻止后续代码未经检查就访问它的属性。
  const choice = isRecord(value) && Array.isArray(value.choices) ? value.choices[0] as unknown : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  // || 从左到右短路求值：前面检查失败就不继续访问后面的字段。
  // trim 仅判断空白，实际返回下方原始 content，保留回答中的空格和换行。
  if (!isRecord(message) || message.role !== "assistant" || typeof message.content !== "string" || !message.content.trim()) {
    throw new ResponseError("响应解析失败：需要非空的 choices[0].message assistant 文本。");
  }
  const response: LlmResponse = { message: { role: "assistant", content: message.content } };
  // usage 是可选字段，缺失可以成功；存在时必须满足约定，不能只做类型断言。
  if (isRecord(value) && value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new ResponseError("响应解析失败：usage 必须是对象。");
    const usage: LlmUsage = {};
    // 数组每项是“服务端字段名、领域字段名”，解构到 source/target。
    // as const 保留精确字符串类型，让 TS 知道 target 只可能是两个合法属性名。
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

/**
 * 从失败的 HTTP 响应中提取可展示的短摘要，帮助用户诊断服务端拒绝请求的原因。
 * complete 收到非 2xx 响应后调用它，并将结果放入 RequestError。
 * 按字节读取最多 512 字节，替换已知密钥和认证头文本、去除控制字符，再限制输出长度。
 * byte 与字符数量不同，例如 UTF-8 的一个汉字通常占 3 字节。
 *
 * @param response 待读取的失败响应；它的 body 会被消费，不能再完整读取第二遍。
 * @param apiKey 本次认证密钥，仅用来匹配并遮盖错误体中可能回显的内容。
 * @returns Promise<string>，成功得到最多 512 字节的摘要；没有 body 时为空字符串。
 * 读取失败会使 Promise 拒绝，由 complete 转成请求错误；finally 会取消剩余读取并释放锁。
 */
async function readErrorSummary(response: Response, apiKey: string): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  // Uint8Array 保存原始字节，length 记录实际装入的数量，而不是字符串长度。
  const bytes = new Uint8Array(512);
  let length = 0;
  try {
    while (length < bytes.length) {
      // read 返回 Promise；await 后解构出当前数据块和是否结束。
      const { value, done } = await reader.read();
      if (done) break;
      // 网络数据块可能超过剩余容量，subarray 只取最多还能容纳的部分。
      const part = value.subarray(0, bytes.length - length);
      bytes.set(part, length);
      length += part.length;
    }
  } finally {
    // 即使达到上限或 read 失败，也要取消剩余读取并释放 reader 锁。
    // catch(() => undefined) 只忽略取消清理自身的失败，read 失败仍向外传播。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  // 不再 flush 的 stream 解码会留下截断处未完成的 UTF-8 字符，避免输出乱码。
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
  // 脱敏标记可能比原文本更长，因此输出前还需再次按字节截断。
  return new TextDecoder().decode(Buffer.from(summary).subarray(0, 512), { stream: true });
}

/** implements 在编译期检查接口；实际网络行为由下面的方法实现。 */
export class OpenCodeGoClient implements LlmClient {
  /**
   * 保存连接参数，创建一个供 runPrompt 使用的 OpenCode Go 客户端。
   * CLI 在 loadConfig 校验成功后调用 new OpenCodeGoClient(config)。
   *
   * @param config 密钥、API 基地址和单次请求超时；由调用方提供已校验的值。
   * 构造完成得到客户端实例，此时尚不发请求、不启动定时器，也不创建持久会话。
   */
  // 参数属性：把传入的 config 保存为私有字段 this.config；readonly 禁止重绑该字段，
  // 不意味着 config 内部属性被深度冻结。每次请求的可变状态放在 complete 内。
  constructor(private readonly config: OpenCodeGoClientOptions) {}

  /**
   * 将一次模型请求发给 OpenCode Go，读取并校验响应，返回统一的回答对象。
   * core/runPrompt 通过 LlmClient 接口调用它；HTTP 细节都在本方法内处理。
   * 执行顺序：建立超时/取消控制 → POST 消息 → 检查状态 → 读取并解析响应 → 清理资源。
   *
   * @param request 模型标识和有序消息；序列化时添加 stream:false，不修改调用方对象。
   * @param signal 可选的调用方取消信号，与内部超时合并；已取消时不成功返回回答。
   * @returns Promise<LlmResponse>，成功得到非空 assistant 文本与可选 token 用量。
   * @throws RequestError 网络失败、超时或 HTTP 非 2xx；通过拒绝 Promise 传递。
   * @throws ResponseError 响应不是有效 JSON 或不符合回答结构。
   * @throws AbortError 调用方取消请求；与超时按先触发者确定原因。
   * 每次调用产生独立路由 UUID 和控制器，超时覆盖响应体读取；
   * 成功或失败均清理定时器及监听器，不在此处打印或保存回答。
   */
  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    // 外部 signal 与超时共用一个内部控制器，底层 fetch 只接收这个内部 signal。
    // AbortController 是发出取消的对象，signal 是观察取消状态的对象。
    const controller = new AbortController();
    let abortKind: "timeout" | "caller" | undefined;
    // 箭头函数形成闭包，访问本次 complete 的 controller 和 abortKind。
    // 若已取消就直接返回，保留首次触发原因，避免超时/调用方相互覆盖。
    /**
     * 停止本次 HTTP 操作并记住原因，供下方 catch 将底层异常转成正确的业务错误。
     * 超时回调和 onAbort 调用它；kind 是 timeout 或 caller。
     * 不返回结果；第一次调用会取消内部 signal，后续调用直接跳过。
     */
    const abort = (kind: "timeout" | "caller") => {
      if (controller.signal.aborted) return;
      abortKind = kind;
      controller.abort();
    };
    /** 将外部取消事件转成 abort("caller")；也用于处理传入时就已取消的 signal。 */
    const onAbort = () => abort("caller");
    // 传的是函数引用，不是 onAbort() 的调用结果；事件发生时才执行回调。
    // ?. 表示未传 signal 就跳过监听，once 表示监听最多触发一次。
    signal?.addEventListener("abort", onAbort, { once: true });
    // 注册监听不会补发过去的事件，因此还要处理调用前已取消的 signal。
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => abort("timeout"), this.config.timeoutMs);
    // 收到响应头前可能失败，所以状态码最初为 undefined。
    let status: number | undefined;

    try {
      // fetch resolve 通常表示收到响应头，不能认为整个响应体已读完。
      // HTTP 4xx/5xx 也会 resolve；网络或 signal 取消才通常 reject。
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "x-opencode-session": randomUUID(),
        },
        // JSON.stringify 把 JS 对象序列化成请求体文本；仅发送最小协议字段。
        body: JSON.stringify({ model: request.model, messages: request.messages, stream: false }),
        signal: controller.signal,
        // 不自动跟随重定向，将其作为请求失败，避免意外进入另一个地址。
        redirect: "error",
      });
      status = response.status;
      if (!response.ok) {
        // ok 表示 HTTP 200—299；失败时不尝试解析正常 completion 格式。
        const summary = await readErrorSummary(response, this.config.apiKey);
        throw new RequestError("http", `模型请求失败（HTTP ${status}）${summary ? `：${summary}` : "。"}`, status, summary);
      }
      // 读取响应体也在同一个超时边界内；JSON 错误与传输中断分开处理。
      const body = await response.text();
      // 等待响应体完成后再次检查，已取消的请求不能当作成功返回。
      controller.signal.throwIfAborted();
      let parsed: unknown;
      try {
        // JSON.parse 只验证 JSON 语法，返回值仍当 unknown，后续再验证业务结构。
        parsed = JSON.parse(body) as unknown;
      } catch {
        throw new ResponseError("响应解析失败：服务未返回有效 JSON。");
      }
      return parseResponse(parsed);
    } catch (error) {
      // 取消时 fetch/reader 的底层异常格式并不统一，先用自有状态判定原因。
      // throw 让当前 async 方法的 Promise reject，由 CLI 的 await/catch 接住。
      if (abortKind === "caller") throw new AbortError("模型请求已取消。");
      if (abortKind === "timeout") {
        throw new RequestError("timeout", `模型请求超时（${this.config.timeoutMs} ms）${status ? `，HTTP ${status}` : ""}。`, status);
      }
      if (error instanceof RequestError || error instanceof ResponseError) throw error;
      // 不转发底层异常，避免 URL、请求头或凭证进入 CLI。
      throw new RequestError("network", `模型请求网络失败${status ? `（读取响应体，HTTP ${status}）` : "（连接或发送阶段）"}。`, status);
    } finally {
      // try 中的所有 await 都结束或抛错后才执行这里，包括成功 return 的路径。
      // 函数返回不会自动取消已注册的定时器；必须手动清理。
      // removeEventListener 要传登记时同一个函数引用，临时创建新箭头函数无法移除它。
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
