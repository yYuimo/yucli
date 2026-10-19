/** core 中两种循环共用的阶段额度，避免流式与非流式路径各自漂移。 */
import { AgentLoopError } from "../contracts/llm-client.js";
import type { AgentLoopOptions } from "../contracts/agent.js";

/**
 * 将调用方的部分选项补齐为完整额度，由 agentLoop/runTurnStream 在任何请求前调用。
 * options 可缩小默认 8 次模型/每批 4 项上限；返回新对象，不修改输入。
 * 非整数、越界值抛 AgentLoopError(protocol_error)，不发请求或执行工具。
 */
export function resolveLoopLimits(options: Partial<AgentLoopOptions>): AgentLoopOptions {
  const maxModelCalls = options.maxModelCalls ?? 8;
  const maxToolCallsPerResponse = options.maxToolCallsPerResponse ?? 4;
  if (
    !Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 8 ||
    !Number.isInteger(maxToolCallsPerResponse) || maxToolCallsPerResponse < 1 || maxToolCallsPerResponse > 4
  ) throw new AgentLoopError("protocol_error", "循环选项超出阶段 02/03 的允许范围。");
  return { maxModelCalls, maxToolCallsPerResponse };
}
