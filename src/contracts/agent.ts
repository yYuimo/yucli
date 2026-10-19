import type { ToolResult } from "./tool.js";

/** 测试可缩小上限，但不能突破阶段 02 的 8 次模型调用和每批 4 个工具调用。 */
export interface AgentLoopOptions {
  maxModelCalls: number;
  maxToolCallsPerResponse: number;
}

/** 仅表示成功；模型/协议/取消失败会抛异常，不返回部分结果。 */
export interface AgentLoopResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  stopKind: "final_text";
}
