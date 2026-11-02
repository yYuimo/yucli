# REPL 与内存会话契约

状态：`accepted`（阶段 03 已实现并通过本地及真实验证）

阶段 04 扩展状态：`draft`（持久化 REPL 和恢复入口尚未实现）

适用阶段：阶段 03，同一进程中的持续对话；阶段 04，带会话保存与恢复的 REPL。

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

## 阶段 04 持久化扩展（draft）

阶段 04 的 REPL 仍由 `bootstrap` 持有最近 20 个成功 turn，但新增一个当前 `SessionWriter` 生命周期：首次非空普通输入才创建会话；`/new` 与 `/clear` 关闭旧会话、清空内存历史，下次普通输入再创建新的 sessionId。旧会话文件保留，不复用其身份。

新增命令的行为如下：

| 输入 | 行为 |
| --- | --- |
| `/resume`、`/resume --all` | 打开共享行式 picker；等待选择时不消费普通问题 |
| `/resume <sessionId>` | 准备候选、取得写锁并重建历史，成功后才替换当前会话 |
| `/new`、`/clear` | 关闭旧 writer，清空历史并回到待创建状态 |

恢复采用“准备候选 → 关闭旧会话 → 替换历史”的顺序。候选 busy、cwd 不匹配、损坏或不支持时，关闭候选资源后保留原会话并允许重试；候选修复、保存、锁或旧会话关闭故障则停止继续接收输入并以存储故障退出。非 TTY 中 `/resume` 不能把下一行当编号，直接报告命令用法并保留历史。

持久化 turn 的历史提交屏障与阶段 03 的临时结果不同：core 交付的每条事实必须等待 `SessionWriter.appendDurable()` 确认；只有 `turn_end(success)` 确认后，REPL 才将完整消息组加入内存历史。失败、取消、超时和保存故障不提交半截历史；保存故障优先于普通取消和退出码。具体 writer、恢复投影、锁和 30 秒/5 秒关闭边界见[会话存储契约](session-store.md)。

上述扩展在实现和验收前保持 `draft`，阶段 03 的 accepted 行为仍以本文件前文为准。

T7 子集已验证：core/runPersistentTurn 交付保存确认后的 CommittedTurnResult；bootstrap/PersistenceSupervisor 提供可注入的停止输入、业务取消、真实关闭及 5 秒应急退出监督。当前 repl.ts 仍是阶段 03 的内存路径，尚未接入凭证、SessionCleanup 或监督回调；这些输入/信号/历史替换的产品接线归 T8，不把单元级监督验证视为 REPL 已持久化。

关联文档：[阶段 03 规格](../specs/phase-03-repl-streaming.md)、[CLI 契约](cli.md)。

## 实现与验证

实现位于 [repl.ts](../../src/bootstrap/repl.ts)，按完整 StreamTurnResult.appendedMessages 分组保存历史，数组快照传给 core；超出 20 组时整体裁剪，不把工具消息单独留存。输入循环在 turn 完成后才处理下一行。[repl.test.ts](../../tests/repl.test.ts) 覆盖源码/构建产物，真实两轮文本、工具往返与 PTY Ctrl+C 结果见阶段 03 规格。
