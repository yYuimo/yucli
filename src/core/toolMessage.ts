/** core 层纯模型投影；实时循环和恢复历史共用，不执行工具或依赖任何 adapter。 */
import type { ToolMessage } from "../contracts/message.js";
import type { ToolResult } from "../contracts/tool.js";

/**
 * 把已校验的业务 ToolResult 转成独立模型消息，由实时/兼容循环和恢复投影调用。
 * 仅显式复制 ID、名称、content，ok:false 和空内容同样保留；额外磁盘/摘要字段不会扩散。
 * 返回新对象、不修改结果，不验证磁盘格式、不访问模型或文件，也不重放执行。
 */
export function toolResultToMessage(result: ToolResult): ToolMessage {
  return { role: "tool", toolCallId: result.toolCallId, name: result.name, content: result.content };
}
