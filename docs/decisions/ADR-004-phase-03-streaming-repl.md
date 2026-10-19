# ADR-004：阶段 03 使用流式事件和内存 REPL

状态：`accepted`

## 背景与问题

阶段 02 每次命令只执行一个 prompt，模型响应在完整 JSON 到达后才输出。阶段 03 需要同一进程连续提问、实时显示文本，并在流式工具调用完成后继续循环。流式响应的 chunk 边界、工具参数交错和取消会改变消息提交时机。

## 决定

- `LlmClient` 保留 `complete()`，新增 `stream()`，返回 provider-neutral 的 `LlmStreamEvent` async generator。
- adapter 只负责字节、SSE 和 OpenAI 字段转换；core 用按 index 的 assembler 拼装工具调用。
- 文本 delta 直接顺序写 stdout；不提前抽 renderer 抽象。
- REPL 外层持有内存历史，core 每轮接收历史快照并返回成功 turn 结果。
- 历史最多保留 20 个完整 user turn；不做 token 预算和压缩。
- 当前轮次任意流式失败、取消或工具批次协议错误时，不提交半截消息。
- active-stream Ctrl+C 取消当前轮并回到 REPL；idle-input Ctrl+C 退出 130；单次模式取消退出 4。
- `finish_reason: "length"`、message end 前断流和任一工具调用非法都不执行工具；
  合法 message end 到达后流直接关闭、没有 `[DONE]` 也按成功处理。

## 理由与取舍

并行保留 `complete()` 可以让阶段 01/02 的调用和测试继续稳定；async generator 让调用方自然按顺序消费 delta。按 index 的状态机避免参考实现中单变量累积导致交错工具串线。REPL 持有历史使生命周期直观，也为阶段 04 的持久化提供明确边界。

朴素 stdout 渲染牺牲了后续 Markdown/TUI 的灵活性，但能把本阶段重点放在流协议和取消上。20 turn 上限不能解决 token 级上下文问题，但能防止无限增长；阶段 04 再决定持久化和压缩。

## 影响

- 新增流式事件、SSE、REPL 和 turn 结果契约。
- OpenCode Go adapter 增加 `stream: true` 和 SSE reader。
- core 增加流式 assembler 与可接收历史的 turn 流程。
- CLI 无 `--prompt` 时进入 REPL，保留单次模式兼容。
- 测试需要可控的本地 SSE 服务和信号/超时场景。

## 关联阶段、契约和代码

- [阶段 03 规格](../specs/phase-03-repl-streaming.md)
- [流式模型与 SSE 契约](../contracts/streaming.md)
- [REPL 契约](../contracts/repl.md)
- [LlmClient 契约](../contracts/llm-client.md)
