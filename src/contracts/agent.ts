import type { ToolResult } from "./tool.js";

/** 测试可缩小上限，但不能突破阶段 02 的 8 次模型调用和每批 4 个工具调用。 */
export interface AgentLoopOptions {
  // 包含第一次请求；第 N 次若仍请求工具，不执行那批，直接以 loop_limit 失败。
  maxModelCalls: number;

  // 针对一条 assistant 响应的调用总数；不是整个命令累计执行的工具次数。
  maxToolCallsPerResponse: number;
}

/** 仅表示成功；模型/协议/取消失败会抛异常，不返回部分结果。 */
export interface AgentLoopResult {
  // 最终 assistant 原文，不包含中间工具结果或 reasoning，CLI 只打印这个字段。
  finalText: string;
  modelCalls: number;

  // 按执行顺序保留配对结果；其中 ok:false 不代表整个 AgentLoop 一定失败。
  toolResults: readonly ToolResult[];
  stopKind: "final_text";
}
