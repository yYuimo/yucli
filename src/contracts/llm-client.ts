// import type 只引入编译期类型，不会在生成的 JS 中执行模块导入。
// ESM 源码使用 .js 后缀，TypeScript 检查时会解析对应 .ts 文件。
import type { LlmRequest, LlmResponse } from "./message.js";

/**
 * core 依赖的模型能力，OpenCodeGoClient 负责实现。
 * 类比 Java 接口，但 TS 按对象结构检查：具有兼容方法的对象即可满足接口。
 */
export interface LlmClient {
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
