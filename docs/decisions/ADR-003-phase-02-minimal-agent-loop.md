# ADR-003：阶段 02 采用顺序只读工具循环

状态：`proposed`

## 背景与问题

阶段 01 只能完成一次模型问答。要让模型读取文件，需要在一次命令中保存消息历史、执行模型返回的工具调用，并把工具结果继续交给模型。Pi、ZCode 和 DSH 都有更完整的循环、事件和资源管理设计；直接引入会让当前学习阶段同时面对并发、持久化和插件生命周期。

## 决定

阶段 02 采用一个位于 `core` 的顺序 `AgentLoop`，只注册一个 `read_file` 工具：

- 每次模型调用携带完整的当前消息历史和工具定义。
- 一次 assistant 响应中的多个工具调用按返回顺序串行执行。
- 可恢复的文件错误作为 `ok: false` 的 tool message 返回给模型。
- 每次命令最多进行 8 次模型调用；上限不作为 CLI 参数暴露。
- 第 8 次响应如果仍包含工具调用，不执行该批次，也不发起第 9 次模型调用。
- 单个 assistant 响应最多包含 4 个工具调用；任一调用结构非法时整批失败，一个调用都不执行。
- `read_file` 只允许当前工作区内的相对 UTF-8 文本文件，最大 64 KiB。
- 读取先 `stat` 再读 Buffer，使用 fatal UTF-8 解码；65536 字节允许，65537 字节拒绝，空文件允许。
- 消息历史只保存在当前进程，不引入会话存储或事件溯源。

## 理由与取舍

顺序执行最容易观察消息如何变化，也能避免本阶段引入并发、结果排序和取消竞态。把工具错误交给模型保留了模型解释错误的机会，同时不会把普通文件问题误报为程序崩溃。循环、工具批次和文件大小上限分别控制模型失控、单轮调用数量和上下文膨胀风险。截断响应和结构性非法调用采用全有或全无规则，避免消息历史出现无法配对的工具结果。

代价是同一轮的多个文件读取不能并行，且 64 KiB 不能覆盖大文件场景；这些能力需要后续阶段重新设计，而不是在本阶段隐式放宽边界。

## 影响

- `Message`、`LlmRequest`、`LlmResponse` 必须支持 assistant tool calls 和 tool messages。
- OpenCode Go adapter 必须发送 `tools` 并解析 `tool_calls`。
- `tools` 为空时必须省略请求字段；`finish_reason: "length"` 必须在 adapter 层失败。
- 新增 `ToolRegistry`、`ReadFileTool` 和 AgentLoop 测试。
- 真实联调需要验证多轮 HTTP 请求各自生成独立 `x-opencode-session` 仍可完成一次工具往返。
- 阶段 01 的一次性 CLI 行为和退出码保持兼容。
- 后续引入 REPL、流式输出、并发工具、写文件或会话恢复时，需要重新评估本 ADR。

## 关联阶段、契约和代码

- [阶段 02 规格](../specs/phase-02-read-file-agent-loop.md)
- [工具执行契约](../contracts/tool-execution.md)
- [LlmClient 契约](../contracts/llm-client.md)
- [OpenCode Go HTTP 契约](../contracts/opencode-go-http.md)
- [CLI 行为契约](../contracts/cli.md)
- 预期代码：`src/core/agentLoop.ts`、`src/adapters/filesystem/ReadFileTool.ts`
