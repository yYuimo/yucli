import type { Message } from "./message.js";
import type { ToolResult } from "./tool.js";

/**
 * 一次 AgentLoop 的运行额度配置，由调用方提供，循环开始时读取和校验。
 * 这是 core 的流程选项，不是 HTTP 请求参数，模型不能通过工具参数修改它。
 * agentLoop 接收 Partial<AgentLoopOptions>，因此调用方可只覆盖其中一个字段；
 * 省略时分别用 8 和 4，测试可缩小。number 类型不能保证整数/范围，仍需运行时校验。
 */
export interface AgentLoopOptions {
  /**
   * 最多调用模型的次数，允许 1—8，包含第一次请求。
   * 最后一次返回最终文本可成功；仍请求工具则不执行该批，抛 loop_limit。
   */
  maxModelCalls: number;

  /**
   * 一条 assistant 响应允许包含的工具调用总数，允许 1—4。
   * 不是整个命令累计工具次数；整批超限时一个调用也不执行。
   */
  maxToolCallsPerResponse: number;
}

/**
 * 一次 AgentLoop 成功完成整个工具往返后的结果，由循环创建并交给 CLI/其他调用方。
 * 与 LlmResponse 不同：它表示命令已经结束，而非仅一次模型请求结束。
 * 只有得到最终文本才返回；模型错误、协议错误、额度耗尽和取消通过异常传播，
 * 不返回“带失败状态的部分结果”。普通文件错误可在模型解释后仍得到成功结果。
 */
export interface AgentLoopResult {
  /** 最终 assistant 原文，保留空格/换行；保留为成功结果；阶段 03 CLI 已在流中逐片显示，不再重复打印它。 */
  finalText: string;

  /** 实际已完成的模型请求次数，包含发起工具调用的轮次和最后生成答案的轮次。 */
  modelCalls: number;

  /**
   * 按执行顺序保留本次命令的配对结果，直接回答时为空数组。
   * readonly 防止调用方经此类型增删数组元素，不深度冻结结果对象。
   */
  toolResults: readonly ToolResult[];

  /** 成功停止原因；当前只允许 final_text，失败不通过这个字段表示。 */
  stopKind: "final_text";
}

/**
 * 流式 turn 完整成功的临时交付结果，由 runTurnStream 创建；非持久化 REPL 可以直接提交。
 * 持久化路径必须等 runPersistentTurn 保存 turn_end 后交付 CommittedTurnResult，才可提交历史。
 * 继承阶段 02 成功结果的文本、次数、工具结果与停止原因，不增加失败状态。
 * 流中途失败会抛异常，没有可提交结果；屏幕已经显示的片段不会自动变成历史。
 */
export interface StreamTurnResult extends AgentLoopResult {
  /**
   * 当前 turn 的完整 user/assistant/tool 消息组；不含传入的旧历史。
   * readonly 约束数组操作，不深度冻结消息对象；REPL 仅在成功后一次性追加。
   */
  appendedMessages: readonly Message[];
}
