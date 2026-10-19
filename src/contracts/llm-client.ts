// import type 只引入编译期类型，不会在生成的 JS 中执行模块导入。
// ESM 源码使用 .js 后缀，TypeScript 检查时会解析对应 .ts 文件。
import type { LlmRequest, LlmResponse, LlmStreamEvent } from "./message.js";

/**
 * 应用调用模型所依赖的能力接口，把 core 与具体提供方隔开。
 * OpenCodeGoClient 提供真实实现；CLI 创建实现并注入流式 turn，测试可注入有相同方法的对象。
 * 它约定 complete/stream 的输入、异步输出和失败行为，不保存模型配置或消息历史。
 * 类比 Java 接口，但 TS 采用结构类型：对象只要具备兼容方法，不显式 implements 也能匹配。
 * 编译后接口不存在，不能 new LlmClient 或用 instanceof LlmClient；执行的是具体对象的方法。
 */
export interface LlmClient {
  /**
   * 接收一组模型消息，完成一次模型调用，返回经过校验的 assistant 回答。
   * core/runPrompt 与 core/agentLoop 调用此接口，具体 HTTP 实现由 adapter 提供。
   *
   * @param request 要使用的模型和按顺序排列的消息，实现方不得修改它们。
   * @param signal 可选取消信号；取消后不能继续将结果作为成功返回。
   * @returns Promise，成功时包含 assistant 文本或工具调用，以及可选用量。
   * 网络、超时、协议错误或取消通过拒绝 Promise 交给调用方处理。
   */
  // Promise<LlmResponse> 是未来完成的结果；调用方 await 后才取得 LlmResponse。
  // signal? 表示可选取消信号。成功 resolve；失败 reject，交给调用方处理。
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;

  /**
   * 逐步交付一次模型响应，供 runTurnStream 边显示文本边拼装工具请求。
   * request 是当前完整历史及工具定义，signal 是当前 turn 的可选取消信号；不修改输入。
   * 返回 AsyncGenerator，调用方通过 for await...of 顺序消费；开始迭代时才发 HTTP 请求。
   * message_end 表示逻辑收尾，usage 为独立事件；网络、协议、超时和取消以异常传播。
   * 调用方提前 break/return 时，实现必须释放 reader、定时器和监听器。
   */
  stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent>;
}

// 这些类在运行时真实存在，因此 CLI 可以通过 instanceof 区分它们。
// 错误分类属于契约，具体退出码由 bootstrap 决定。
export class ConfigError extends Error {
  // override 明确声明覆盖父类 Error.name，便于诊断时识别错误种类。
  override name = "ConfigError";
}

/**
 * 请求错误分类的字符串联合；程序读取 code 区分失败，message 则用于给用户看。
 * network 包含连接/发送/响应体中断，timeout 为超时先触发，http 为已收到非 2xx 响应。
 */
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

/** core 的停止原因：额度耗尽或协议不合法；CLI 均映射为退出码 4，普通文件错误不在此列。 */
export type AgentLoopErrorCode = "loop_limit" | "protocol_error";

/** core 的循环失败；CLI 用 code 分类、用安全 message 输出，统一退出码 4。 */
export class AgentLoopError extends Error {
  override name = "AgentLoopError";

  /**
   * 创建表示“本次命令必须停止”的循环或协议错误，供 core 校验及循环控制代码抛出。
   * CLI 根据错误类型映射到退出码 4，而不是将它作为可恢复 tool 消息交给模型。
   *
   * @param code loop_limit 表示额度用完，protocol_error 表示选项、批次或执行协议不合法。
   * @param message 可向用户显示的固定说明，不包含路径、模型原文、底层异常或密钥。
   * 构造后得到保存 code/message 的异常实例；只有调用方 throw 后才会使异步流程失败。
   */
  constructor(public readonly code: AgentLoopErrorCode, message: string) {
    super(message);
  }
}
