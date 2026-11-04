/** core 层恢复业务快照的纯模型投影；只消费 T5 已校验成功组，不读文件、不恢复旧执行。 */
import type { Message } from "../contracts/message.js";
import type { RecoveredItem, RecoveredTurn } from "../contracts/session.js";
import { toolResultToMessage } from "./toolMessage.js";

/**
 * 将一项已校验恢复业务数据投影为新的模型消息；projectSessionHistory 按原顺序调用。
 * 显式复制字段，assistant 的调用数组也独立复制，防止调用方修改历史时改动原快照。
 * 不携带 seq/profile/assistantId，不从诊断推断结果，不执行工具；合法输入由存储边界保证。
 */
function projectItem(item: RecoveredItem): Message {
  if (item.type === "tool_result") return toolResultToMessage(item.result);
  if (item.type === "user") return { role: "user", content: item.message.content };
  const { content, toolCalls } = item.message;
  return {
    role: "assistant",
    ...(content === undefined ? {} : { content }),
    ...(toolCalls === undefined ? {} : {
      // 只复制模型调用的三个业务字段，不以对象展开把未来存储字段混入请求。
      toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })),
    }),
  };
}

/**
 * 把 T5 recentSuccessfulTurns 投影为按 turn 分组的模型历史，供后续协调方/REPL 使用。
 * 输入的 RecoveredTurn 本身只代表完整 success，不接受失败/取消/超时/中断诊断；无需另造 outcome。
 * 先按文件顺序取最近 20 个整组，再逐项转换；返回独立二维数组，空输入返回空数组。
 * 本函数纯计算、不裁剪磁盘、不拼接失败 user、不发请求或执行工具，不生成任何持久化事实。
 */
export function projectSessionHistory(turns: readonly RecoveredTurn[]): Message[][] {
  return turns.slice(-20).map((turn) => turn.items.map(projectItem));
}
