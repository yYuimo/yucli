/**
 * adapters 层：把 yucli 的模型契约转换为 OpenCode Go HTTP 协议。
 * 非流式 complete 返回领域响应；流式 stream 逐步交付 SSE 映射后的业务事件。
 * 本模块负责网络资源和协议校验；不打印终端文本、不保存会话。
 */
import { SseParser } from "./SseParser.js";
import { parseStreamChunk } from "./streamChunk.js";
import { randomUUID } from "node:crypto";
import { AbortError, RequestError, ResponseError } from "../../contracts/llm-client.js";
import type { LlmClient } from "../../contracts/llm-client.js";
import type { ToolCall } from "../../contracts/tool.js";
import type { LlmRequest, LlmResponse, LlmStreamEvent, LlmUsage, Message } from "../../contracts/message.js";

/**
 * 创建 OpenCodeGoClient 时必须提供的连接配置，由 bootstrap 注入，客户端保存后逐次使用。
 * 只包含 HTTP 连接所需的字段；model/messages 属于每次 complete/stream 的 LlmRequest。
 * RuntimeConfig 包含这些同名兼容字段，因此可以直接传入，不需要继承本接口。
 * 此接口不调用 dotenv 或做运行时校验，调用方应传入 loadConfig 校验后的值。
 */
export interface OpenCodeGoClientOptions {
  /** 认证密钥；客户端只将它用于 Authorization 及错误摘要脱敏，不放进 body。 */
  apiKey: string;

  /** 提供方 API 基地址，允许带 /v1 等路径；每次请求再拼接 /chat/completions。 */
  baseUrl: string;

  /** 本次请求的超时毫秒数；每次 complete/stream 各自创建和清理定时器。 */
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
 * 先检查 assistant 文本/工具调用及截断信号，再校验并映射可选的 token 用量。
 *
 * @param value JSON.parse 得到的未验证数据；标为 unknown 强制逐项检查。
 * @returns 新的领域响应对象，保留回答原文，只提取约定字段，不返回 reasoning 或原始 JSON。
 * @throws ResponseError 字段/调用 ID 非法、既无文本又无调用、响应截断或用量非法时抛出。
 * 这里只检查工具调用外层结构；参数 JSON 和 path 结构由 core 在整批执行前继续校验。
 * 本函数不修改输入、不发请求、不输出日志。
 */
function parseResponse(value: unknown): LlmResponse {
  // 三元表达式“条件 ? 真时的值 : 假时的值”；先检查对象和数组，才尝试取第一项。
  // as unknown 不验证元素内容，只阻止后续代码未经检查就访问它的属性。
  const choice = isRecord(value) && Array.isArray(value.choices)
    ? value.choices[0] as unknown
    : undefined;
  const message = isRecord(choice) ? choice.message : undefined;

  if (!isRecord(choice) || !isRecord(message) || message.role !== "assistant") {
    throw new ResponseError("响应解析失败：需要 assistant 消息。");
  }

  // 截断时即使 JSON 和工具参数看似完整，也不能执行可能不完整的模型意图。
  if (choice.finish_reason !== undefined && typeof choice.finish_reason !== "string") {
    throw new ResponseError("响应解析失败：finish_reason 必须是字符串。");
  }

  if (choice.finish_reason === "length") {
    throw new ResponseError("响应被截断（finish_reason=length），不执行工具。");
  }

  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") {
    throw new ResponseError("响应解析失败：content 必须是文本。");
  }

  const calls: ToolCall[] = [];
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) {
      throw new ResponseError("响应解析失败：tool_calls 必须是数组。");
    }

    const ids = new Set<string>();
    for (const call of message.tool_calls as unknown[]) {
      if (
        !isRecord(call) || call.type !== "function" ||
        typeof call.id !== "string" || !call.id.trim() || ids.has(call.id) ||
        !isRecord(call.function) || typeof call.function.name !== "string" ||
        !call.function.name.trim() || typeof call.function.arguments !== "string"
      ) {
        throw new ResponseError("响应解析失败：工具调用结构或调用 ID 非法。");
      }

      ids.add(call.id);
      calls.push({ id: call.id, name: call.function.name, argumentsJson: call.function.arguments });
    }
  }

  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim() && calls.length === 0) {
    throw new ResponseError("响应解析失败：需要非空文本或工具调用。");
  }

  const response: LlmResponse = { message: { role: "assistant", content } };
  if (calls.length) response.message.toolCalls = calls;
  if (choice.finish_reason !== undefined) response.finishReason = choice.finish_reason;

  // usage 是可选字段，缺失可以成功；存在时必须满足约定，不能只做类型断言。
  if (isRecord(value) && value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new ResponseError("响应解析失败：usage 必须是对象。");
    const usage: LlmUsage = {};

    // 数组每项是“服务端字段名、领域字段名”，解构到 source/target。
    // as const 保留精确字符串类型，让 TS 知道 target 只可能是两个合法属性名。
    for (const [source, target] of [
      ["prompt_tokens", "inputTokens"],
      ["completion_tokens", "outputTokens"],
    ] as const) {
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
 * complete/stream 收到非 2xx 响应后调用它，并将结果放入 RequestError。
 * 按字节读取最多 512 字节，替换已知密钥和认证头文本、去除控制字符，再限制输出长度。
 * byte 与字符数量不同，例如 UTF-8 的一个汉字通常占 3 字节。
 *
 * @param response 待读取的失败响应；它的 body 会被消费，不能再完整读取第二遍。
 * @param apiKey 本次认证密钥，仅用来匹配并遮盖错误体中可能回显的内容。
 * @returns Promise<string>，成功得到最多 512 字节的摘要；没有 body 时为空字符串。
 * 读取失败会使 Promise 拒绝，由调用方法转成请求错误；finally 会取消剩余读取并释放锁。
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

/**
 * 把一条内部消息转换成 OpenCode Go 接收的 OpenAI 兼容消息对象。
 * complete/stream 构造请求体时按历史顺序 map 调用，确保工具 ID 能从模型调用对应到工具结果。
 *
 * @param message 内部 user/system/assistant/tool 消息，由 core 构造并按契约提供。
 * @returns 新的可序列化对象：toolCallId 改为 tool_call_id，toolCalls 改为 tool_calls，
 * 每个调用包装成 {id,type:"function",function:{name,arguments}}，参数原文保持字符串。
 * tool 消息省略 name，模型停止原因不属于消息字段。空的 toolCalls 不发送。
 * 本函数不修改原消息、不读取文件、不发请求，也不重新解析工具参数；JSON.stringify 在调用方执行。
 */
function toWireMessage(message: Message): object {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      } : {}),
    };
  }

  return { role: message.role, content: message.content };
}

/** implements 在编译期检查接口；实际网络行为由下面的方法实现。 */
export class OpenCodeGoClient implements LlmClient {
  /**
   * 保存连接参数，创建一个供 AgentLoop 或直接问答入口使用的 OpenCode Go 客户端。
   * CLI 在 loadConfig 校验成功后调用 new OpenCodeGoClient(config)。
   *
   * @param config 密钥、API 基地址和单次请求超时；由调用方提供已校验的值。
   * 构造完成得到客户端实例，此时尚不发请求、不启动定时器，也不创建持久会话。
   */
  // 参数属性：把传入的 config 保存为私有字段 this.config；readonly 禁止重绑该字段，
  // 不意味着 config 内部属性被深度冻结。每次请求的可变状态放在 complete/stream 内。
  constructor(private readonly config: OpenCodeGoClientOptions) {}

  /**
   * 将一次模型请求发给 OpenCode Go，读取并校验响应，返回统一的回答对象。
   * core/agentLoop 或保留的 runPrompt 通过 LlmClient 接口调用它；HTTP 细节都在此处理。
   * 执行顺序：建立超时/取消控制 → POST 消息 → 检查状态 → 读取并解析响应 → 清理资源。
   *
   * @param request 模型标识和有序消息；序列化时添加 stream:false，不修改调用方对象。
   * @param signal 可选的调用方取消信号，与内部超时合并；已取消时不成功返回回答。
   * @returns Promise<LlmResponse>，成功得到 assistant 文本或工具调用及可选用量。
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

    /**
     * 把调用方的取消信号转发给本轮 HTTP 请求，与超时取消共用内部控制器。
     * 外部 abort 事件触发时执行；若传入时已经取消，也会在登记后立即手动调用。
     * 无函数参数和返回值；只调用 abort("caller")，具体网络停止由内部 signal 驱动。
     * 在 finally 通过同一个函数引用移除监听，不创建新的请求或另一个控制器。
     */
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
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),
          ...(request.tools?.length ? {
            tools: request.tools.map((tool) => ({ type: "function", function: tool })),
          } : {}),
          stream: false,
        }),
        signal: controller.signal,

        // 不自动跟随重定向，将其作为请求失败，避免意外进入另一个地址。
        redirect: "error",
      });
      status = response.status;

      if (!response.ok) {
        // ok 表示 HTTP 200—299；失败时不尝试解析正常 completion 格式。
        const summary = await readErrorSummary(response, this.config.apiKey);
        throw new RequestError(
          "http",
          `模型请求失败（HTTP ${status}）${summary ? `：${summary}` : "。"}`,
          status,
          summary,
        );
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
        throw new RequestError(
          "timeout",
          `模型请求超时（${this.config.timeoutMs} ms）${status ? `，HTTP ${status}` : ""}。`,
          status,
        );
      }
      if (error instanceof RequestError || error instanceof ResponseError) throw error;

      // 不转发底层异常，避免 URL、请求头或凭证进入 CLI。
      throw new RequestError(
        "network",
        `模型请求网络失败${status ? `（读取响应体，HTTP ${status}）` : "（连接或发送阶段）"}。`,
        status,
      );
    } finally {
      // try 中的所有 await 都结束或抛错后才执行这里，包括成功 return 的路径。
      // 函数返回不会自动取消已注册的定时器；必须手动清理。
      // removeEventListener 要传登记时同一个函数引用，临时创建新箭头函数无法移除它。
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 发起一次 SSE 请求并逐步交付业务事件，供 runTurnStream 驱动一轮模型响应。
   * request 包含完整历史和可选工具；不修改输入，按流式契约使用 stream:true 与独立路由 UUID。
   * async generator 在 for await 迭代时开始执行，yield 暂停后由消费者继续请求下个事件。
   * 只有合法 message_end 才可成功结束；[DONE] 可选，usage 独立并按值去重。
   * 外层 HTTP 失败使用 RequestError；字节/SSE/协议/提前断流使用 ResponseError；
   * 调用方取消使用 AbortError，超时使用 RequestError(timeout)，原因以先触发者为准。
   * finally 在正常结束、异常或调用方提前关闭 generator 时取消 reader、释放锁并清理定时器。
   * 本方法只发网络请求，不打印、不执行工具、不保存跨轮历史。
   */
  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent> {
    // 1. 每次请求独占控制器：外部 turn 取消和本请求超时都汇入它，fetch 只观察它的 signal。
    // abortKind 单独保留业务原因，因为底层 fetch/reader 抛出的取消异常不保证具有统一形状。
    const controller = new AbortController();
    let abortKind: "timeout" | "caller" | undefined;

    /** 超时和外部信号共用的取消入口；只记首次原因，无返回值，并停止本次 fetch/读取。 */
    const abort = (kind: "timeout" | "caller") => {
      // 保留首次原因，例如用户先取消后定时器才到期，最终仍应报“取消”而不是“超时”。
      if (controller.signal.aborted) return;
      abortKind = kind;
      controller.abort();
    };

    /** 外部 abort 事件转发到本次控制器；finally 用此引用移除监听。 */
    const onAbort = () => abort("caller");

    // 监听只接收未来事件，所以登记后还要检查调用前是否已经取消。
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // 单次请求总期限包含连接、读取与收尾，不因收到响应头或首个片段而重置。
    const timer = setTimeout(() => abort("timeout"), this.config.timeoutMs);

    // reader 取得前也可能失败，因此允许 undefined，finally 再按是否存在决定释放。
    // ended 只记录 message_end；网络 EOF/[DONE] 与逻辑消息结束是不同的状态。
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let status: number | undefined;
    let ended = false;

    // 只保存规范化用量的值，不保存整份 provider chunk；同一请求重复统计不重复发事件。
    const seenUsage = new Set<string>();

    /**
     * 把一帧 data 转为事件并维护本次请求的逻辑状态，供下方读取循环调用。
     * 返回去重后的事件；结束后不允许新的文本/调用或第二个 message_end。
     * usage 不进入消息历史；这里只校验传输顺序，工具参数仍由 core 整批预检。
     */
    const eventsFrom = (data: string): LlmStreamEvent[] => {
      const events: LlmStreamEvent[] = [];
      for (const event of parseStreamChunk(data)) {
        if (event.type === "usage") {
          // parseStreamChunk 按固定字段顺序构造 usage，因此可用序列化后的值做去重键。
          // 统计可位于 message_end 后，不能与普通内容一起被 ended 检查拒绝。
          const key = JSON.stringify(event.usage);
          if (seenUsage.has(key)) continue;
          seenUsage.add(key);
        } else {
          // 一次响应只允许一条逻辑消息；结束后再出现文字、工具片段或重复 end 都是协议错误。
          if (ended) throw new ResponseError("message end 后出现新的消息内容或重复收尾。");
          if (event.type === "message_end") ended = true;
        }
        events.push(event);
      }
      return events;
    };

    try {
      // 2. 预取消时直接失败，不能仍向服务端发送一次可能计费的模型请求。
      controller.signal.throwIfAborted();

      // 内部 Message 经 toWireMessage 映射后才进入 HTTP body；每次请求重新生成路由 UUID，
      // 由调用方显式提供历史，不依赖服务端凭路由头自动恢复上下文。
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "x-opencode-session": randomUUID(),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),

          // 没有已注册工具时省略整个字段，不能把空 tools 数组发送给服务端。
          ...(request.tools?.length ? {
            tools: request.tools.map((tool) => ({ type: "function", function: tool })),
          } : {}),
          stream: true,
        }),
        signal: controller.signal,
        redirect: "error",
      });

      // 3. fetch 完成只说明响应头已到达；HTTP 非 2xx 要走限长脱敏摘要，不能当 SSE 解析。
      status = response.status;
      if (!response.ok) {
        const summary = await readErrorSummary(response, this.config.apiKey);
        throw new RequestError("http", `模型请求失败（HTTP ${status}）${summary ? `：${summary}` : "。"}`, status, summary);
      }
      if (!response.body) throw new ResponseError("流式响应没有响应体。");

      // 4. reader 提供原始字节，parser 将字节逐步变成完整 data 帧。
      // 这两个对象只属于本次请求，避免上一轮的半行/半个字符污染下一轮。
      reader = response.body.getReader();
      const parser = new SseParser();

      while (true) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          // 一次 read 可以是半个事件或多个事件；await 只等待下一块，不等待整个回答。
          part = await reader.read();
        } catch {
          // 优先让取消/超时进入外层统一分类；非取消的连接中断才按逻辑收尾状态判断。
          // 已有 message_end 时允许直接断开；之前断开则不能把半截工具意图当作完整请求。
          controller.signal.throwIfAborted();
          if (ended) break;
          throw new ResponseError("流式连接在 message end 前中断。");
        }

        // read 恰好完成时也可能已经取消，因此交付本块事件前再检查一次。
        controller.signal.throwIfAborted();

        // done 表示字节 EOF：flush decoder 并检查半截事件；未 done 则继续增量解码。
        // frames 可能为空，parser 会自行保留尚不完整的尾部，等下一块补齐。
        const frames = part.done ? parser.finish() : parser.push(part.value);
        for (const data of frames) {
          // 5. [DONE] 是传输标记，不是 JSON，也不是“模型已完整回答”的替代依据。
          // 只有先收到 message_end 才能正常 return；return 仍然会进入 finally 清理。
          if (data === "[DONE]") {
            if (!ended) throw new ResponseError("只收到 [DONE]，缺少 message end。");
            return;
          }

          // 一帧可能转换为多个事件。yield 逐个交给 core 并暂停本 generator，
          // core 处理完后请求下一项，才从 yield 之后继续；它不是另起一个线程执行。
          for (const event of eventsFrom(data)) {
            controller.signal.throwIfAborted();
            yield event;
          }
        }
        if (part.done) break;
      }

      // EOF 没有 [DONE] 仍可成功，但必须已经收到 message_end；纯文字片段不够。
      if (!ended) throw new ResponseError("流式响应缺少 message end。");
    } catch (error) {
      // 6. 先按自有取消状态分类，再保留已分类错误，最后把其他底层异常统一成安全网络错误。
      // 不输出 fetch 原始异常，以免 URL、认证信息或 provider 内容进入 CLI。
      if (abortKind === "caller") throw new AbortError("模型请求已取消。");
      if (abortKind === "timeout") throw new RequestError("timeout", `模型请求超时（${this.config.timeoutMs} ms）。`, status);
      if (error instanceof RequestError || error instanceof ResponseError) throw error;
      throw new RequestError("network", "模型流式请求网络失败。", status);
    } finally {
      // 7. 正常结束、抛错和消费者提前 break 都要解除定时器/监听，不能仅依赖 GC。
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      // cancel 主动停止剩余 body；清理失败不能遮盖原来的协议/取消错误。
      if (reader) {
        await reader.cancel().catch(() => undefined);

        // cancel 停止剩余 body，releaseLock 解除独占 reader 的锁，两者职责不同。
        reader.releaseLock();
      }

      // 同时终止本次底层请求，覆盖消费者提前关闭 generator 的路径；不是取消外部 turn。
      controller.abort();
    }
  }

}
