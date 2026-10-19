# 流式模型与 SSE 契约

状态：`draft`（设计已评审，实现验证后转 `accepted`）

适用阶段：阶段 03，OpenCode Go 非流式接口的流式扩展。

本文定义字节流、SSE 事件、内部流式事件和工具调用拼装的边界。它不定义 REPL 历史所有权，REPL 规则见 [REPL 契约](repl.md)。

## 参与方

| 参与方 | 职责 |
| --- | --- |
| `OpenCodeGoClient.stream()` | 发送 `stream: true`，读取 response body，解析 SSE，转换为内部事件 |
| `SseParser` | 按 UTF-8 和 SSE 空行边界产出完整事件，不理解 Agent 工具语义 |
| `StreamAssembler` | 按工具 index/ID 拼装文本和工具调用，处理 finish reason 和收尾 |
| `runTurnStream` | 消费事件、执行完整工具批次、发起下一轮并返回成功 turn 结果 |
| bootstrap | 按序写文本 delta，显示错误和 REPL 状态 |

## 内部事件

```ts
type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "message_end"; finishReason?: string }
  | { type: "usage"; usage: LlmUsage };
```

网络、SSE、JSON、协议、超时和取消错误通过 async generator 抛出稳定错误。正常的 `[DONE]` 不作为业务成功事件单独暴露；adapter 只有在已看到合法的 message end 后才接受它作为可选传输收尾。

`text_delta` 可在最终停止原因确定前发出。调用方可以立即显示它，但只有 message end 成功且没有工具调用时，文本才进入最终 assistant 历史。

## SSE 解析规则

- 使用 `TextDecoder("utf-8", { fatal: true })`，并以 `{ stream: true }` 解码每个字节块；流结束时 flush，半截 UTF-8 直接报错。
- 支持 `\n\n` 和 `\r\n\r\n` 事件分隔；保留尚未完成的尾部 buffer。
- 忽略以 `:` 开头的注释/心跳。
- 多个 `data:` 行按 SSE 规则用换行连接；本协议实际 data 应为一个 JSON 文本或 `[DONE]`。
- 非法 JSON、无法识别的业务 chunk 和流在 message end 前结束都产生 `ResponseError`。
- `[DONE]` 只表示可选传输结束；若此前没有合法 `message_end`，仍是协议错误。message end 已到而流直接关闭，不要求 `[DONE]`，按成功处理。
- reader、decoder、定时器和取消监听器在成功、失败、取消和 generator 关闭时都必须清理。

## OpenAI 兼容 chunk 映射

adapter 从 `choices[0].delta` 转换：

| 外部字段 | 内部事件 |
| --- | --- |
| `delta.content` | `text_delta` |
| `delta.tool_calls[i].index` | `tool_call_delta.index` |
| `delta.tool_calls[i].id` | `tool_call_delta.id` |
| `delta.tool_calls[i].function.name` | `tool_call_delta.name` |
| `delta.tool_calls[i].function.arguments` | `tool_call_delta.argumentsDelta` |
| `choices[0].finish_reason` | `message_end.finishReason` |
| `usage`（若服务端提供） | 独立的 `usage` 事件 |

未知 delta 字段忽略；缺少 choice、delta 形状错误、index 非非负整数或 finish reason 类型错误时拒绝流。

## 工具调用拼装

assembler 维护 `Map<number, ToolCallAssembly>`，每个 index 独立保存：

```ts
interface ToolCallAssembly {
  index: number;
  id: string;
  name: string;
  argumentsJson: string;
}
```

同一 index 的 id/name 可以在后续 delta 补齐，但不能改成另一个非空值；arguments 片段按收到顺序追加。不同 index 可以交错出现，最终按 index 排序。

message end 后必须同时满足：

- 所有调用有非空、唯一 ID 和名称。
- 每个参数 JSON 完整且符合阶段 02 的 `read_file` 参数结构。
- 调用数量不超过 4。
- `finishReason` 不是 `length`。
- 没有工具调用时，累计文本必须是非空白；空文本且无工具调用是 `ResponseError`。

任何一项失败，整批不执行；不得先执行已经看似完整的调用。工具调用没有 message end、只有 `[DONE]` 或连接中断时，同样不执行。

服务端提供 usage 时，adapter 一律发出独立的 `usage` 事件；`message_end` 只携带 `finishReason`，不携带 usage。重复的等值 usage 不重复发出。

## 取消、超时和部分输出

- `stream()` 使用一次独立 AbortController；外部取消和 `YUCLI_REQUEST_TIMEOUT_MS` 以先触发者为准。
- 已发出的 `text_delta` 可以留在 stdout；取消、超时或协议错误状态写入 stderr。
- 未完成的 assistant/tool 消息不进入历史；下一轮从上一次完整历史继续。
- generator 提前 `return` 或被调用方 break 时必须取消 reader 并释放资源。

## 兼容性

`complete()` 的阶段 01/02 语义保持不变。`stream()` 是阶段 03 已接受设计、尚未实现的扩展；未来流式 reasoning、音频、多 provider 或重连需要新增事件类型和契约测试，不能把原始 provider chunk 直接暴露给 core。

关联文档：[阶段 03 规格](../specs/phase-03-repl-streaming.md)、[LlmClient 契约](llm-client.md)、[OpenCode Go HTTP 契约](opencode-go-http.md)。
