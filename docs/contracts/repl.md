# REPL 与内存会话契约

状态：`draft`

适用阶段：阶段 03，同一进程中的持续对话。

## 命令与生命周期

| 输入 | 行为 | 退出状态 |
| --- | --- | ---: |
| 普通文本 | 追加一轮 user 消息并执行流式 turn | 成功后继续等待 |
| 空行 | 忽略，不请求模型 | 继续等待 |
| `/help` | 输出内置命令帮助 | 继续等待 |
| `/clear` | 清空已完成历史 | 继续等待 |
| `/exit`、`/quit` | 结束 REPL | 0 |
| EOF | 结束 REPL | 0 |
| 等待输入时 Ctrl+C | 结束 REPL | 130 |

`--prompt <text>` 保留单次模式，阶段 03 使用 `stream()` 而不是非流式 `complete()`；`complete()` 和阶段 02 的非流式 `agentLoop` 保留为兼容/测试路径。请求错误、超时、协议错误和主动取消返回阶段 01/02 的模型错误退出码 `4`。

## 历史所有权

REPL 持有 `Message[]`，每轮把不可变快照传给 core。core 不读取全局历史，也不修改传入数组；成功 turn 返回新增消息和最终文本，由 REPL 决定提交。

推荐最多保留最近 20 个已完成 user turn。裁剪以完整 turn 为单位：一轮的 user、assistant 工具调用、tool 结果和最终 assistant 必须一起保留或一起删除。阶段 03 不做 token 估算、摘要或上下文压缩。

## Turn 结果

```ts
interface StreamTurnResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  appendedMessages: readonly Message[];
  stopKind: "final_text";
}
```

只有成功返回 `StreamTurnResult` 后，REPL 才把 `appendedMessages` 追加到历史。流式中断、超时、协议错误、循环上限或工具取消都抛出稳定错误，不提交半截消息。

## 输出

- 文本 delta 直接按收到顺序写 stdout。
- 工具调用名称和参数不写 stdout；工具错误通过下一轮模型解释，或作为安全错误写 stderr。
- 一个 turn 完成后确保 stdout 以换行结束，再显示下一次输入提示。
- 错误若发生在已输出部分文本之后，先补换行，再向 stderr 写状态。
- 不显示原始 SSE、Authorization、API key、完整工具参数 JSON 或 reasoning。

## 取消

- 正在流式请求/工具执行时 Ctrl+C：取消当前 turn，清理资源，丢弃未完成消息，回到 REPL 提示符。
- 等待输入时 Ctrl+C：退出进程，返回 130。
- turn 执行中不处理新的输入；需要中断当前 turn 时使用 Ctrl+C。`/clear` 只在提示符可用时清空全部已完成内存历史。

关联文档：[阶段 03 规格](../specs/phase-03-repl-streaming.md)、[CLI 契约](cli.md)。
