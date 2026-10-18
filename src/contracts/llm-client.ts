// import type 只引入编译期类型，不会在生成的 JS 中执行模块导入。
// ESM 源码使用 .js 后缀，TypeScript 检查时会解析对应 .ts 文件。
import type { LlmRequest, LlmResponse } from "./message.js";

/**
 * core 依赖的模型能力，OpenCodeGoClient 负责实现。
 * 类比 Java 接口，但 TS 按对象结构检查：具有兼容方法的对象即可满足接口。
 */
export interface LlmClient {
  /**
   * 接收一组模型消息，完成一次模型调用，返回经过校验的 assistant 回答。
   * core/runPrompt 调用此接口，具体 HTTP 实现由 adapter 提供。
   *
   * @param request 要使用的模型和按顺序排列的消息，实现方不得修改它们。
   * @param signal 可选取消信号；取消后不能继续将结果作为成功返回。
   * @returns Promise，成功时包含非空 assistant 文本和可选用量。
   * 网络、超时、协议错误或取消通过拒绝 Promise 交给调用方处理。
   */
  // Promise<LlmResponse> 是未来完成的结果；调用方 await 后才取得 LlmResponse。
  // signal? 表示可选取消信号。成功 resolve；失败 reject，交给调用方处理。
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

// 这些类在运行时真实存在，因此 CLI 可以通过 instanceof 区分它们。
// 错误分类属于契约，具体退出码由 bootstrap 决定。
export class ConfigError extends Error {
  // override 明确声明覆盖父类 Error.name，便于诊断时识别错误种类。
  override name = "ConfigError";
}

export type RequestErrorCode = "network" | "timeout" | "http";

/** 传输错误：保留稳定分类及安全诊断，不向上暴露原始 fetch 异常。 */
export class RequestError extends Error {
  override name = "RequestError";

  /**
   * 创建供上层识别的模型请求错误，把错误分类和安全诊断装入同一个异常对象。
   * HTTP adapter 在网络失败、超时或 HTTP 非 2xx 时创建，再抛给 CLI。
   *
   * @param code 稳定分类：network、timeout 或 http，供程序判断失败原因。
   * @param message 可直接展示给用户的安全错误说明。
   * @param status 已收到响应头时的 HTTP 状态码；连接失败时可能没有。
   * @param responseSummary HTTP 失败时已脱敏、限长的响应摘要；其他情况可省略。
   * 构造完成得到 RequestError 实例；构造器只保存信息，不会自行抛出或打印。
   */
  constructor(
    // 参数属性：public readonly 同时声明实例字段并将实参赋值给字段。
    // readonly 限制 TS 代码直接重新赋值，不是运行时 Object.freeze。
    public readonly code: RequestErrorCode,
    message: string,
    public readonly status?: number,
    public readonly responseSummary?: string,
  ) {
    // 调用 Error 构造器，初始化 message 等父类信息。
    super(message);
  }
}

/** HTTP 成功，但 JSON 或其字段不满足模型响应契约。 */
export class ResponseError extends Error {
  override name = "ResponseError";
}

/** 调用方主动取消；与到期触发的 RequestError("timeout") 分开。 */
export class AbortError extends Error {
  override name = "AbortError";
}
