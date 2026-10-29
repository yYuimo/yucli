# 工具执行契约

状态：`accepted`

阶段 04 扩展状态：`draft`（持久化事实交付和恢复投影尚未实现）

适用阶段：阶段 02/03，只读 `read_file`、非流式 AgentLoop 与流式 turn；阶段 04，带持久化事实交付的流式 turn。

本文定义模型工具调用如何转换为 yucli 的内部请求、如何执行工具以及如何把结果放回消息历史。它不定义文件编辑、命令执行、MCP 或用户审批。

## 参与方

| 参与方 | 职责 |
| --- | --- |
| `AgentLoop` | 保存一次命令的消息历史，调用模型，分派工具并决定何时结束 |
| `LlmClient` | 将内部消息和工具定义转换为模型请求，并把响应转换为内部 assistant 消息 |
| `ToolRegistry` | 暴露工具定义，根据工具名执行具体工具 |
| `ReadFileTool` | 校验工作区路径并读取 UTF-8 文本 |
| `bootstrap` | 创建工作区根目录、注册工具并注入 AgentLoop |

## 内部数据结构

```ts
interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, { type: "string"; description?: string }>;
  required: readonly string[];
  additionalProperties: false;
}

interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
}

interface ToolDefinition {
  // 阶段 02 只有 read_file；多工具阶段应放宽为受约束的工具名类型。
  name: "read_file";
  description: string;
  parameters: JsonSchema;
}

interface Tool {
  definition: ToolDefinition;
  execute(
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; content: string }>;
}

interface ToolRegistry {
  definitions(): readonly ToolDefinition[];
  execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
}
```

`argumentsJson` 保留模型原始参数文本；core 的工具执行器在整批预检时先 `JSON.parse`，再检查对象、字段类型和允许字段，分派时再次校验；ReadFileTool 接收解析后的对象并复核结构。TypeScript 类型断言不能替代这个运行时检查。

## 消息历史规则

阶段 02 的模型消息扩展为：

```text
user：content
assistant：content 或 tool_calls
tool：tool_call_id、content（内部结果另行保留工具名）
```

AgentLoop 必须按以下顺序追加消息：

1. 初始 user 消息。
2. 模型返回的 assistant 消息，保留文本和完整工具调用；`finishReason` 保留在 LlmResponse 作为本轮判断依据，不发送进消息历史。
3. 每个工具调用对应一个 tool 消息，`tool_call_id` 必须匹配。
4. 下一次模型请求使用完整历史和同一组工具定义。

工具结果不能替换 assistant 工具调用，也不能只把文件内容拼接进下一条 user 消息。这样模型可以区分“模型请求了什么”和“工具实际返回了什么”。

内部 `ToolResult` 可以保留工具名，便于测试和诊断；发送给 OpenAI 兼容接口的 `tool` 消息只发送 `role`、`tool_call_id` 和 `content`，阶段 02 省略可选的 `name` 字段。

一次 assistant 响应可以有多个调用；阶段 02 顺序执行，并按调用顺序追加结果。调用 ID 在同一响应中必须唯一且非空。

assistant 响应的有效性规则是：非空白文本或至少一个合法工具调用，满足其一即可；两者都没有时产生 `ResponseError`。`content` 可以缺失或为 `null`，只要存在合法工具调用即可。

如果同一响应中任一调用缺少 ID、名称，参数 JSON 不是合法 JSON，或参数不是恰好包含字符串 `path` 的对象，则整个响应是协议错误，一个调用都不能执行。名称非空但没有注册、路径越界或文件读取失败属于工具执行错误，生成 `ok: false` 的 tool message。

`finish_reason: "length"` 表示响应可能在文本或工具参数中途被截断。adapter 必须保留该值并产生 `ResponseError`；AgentLoop 不得执行其中任何工具调用。

## `read_file` 输入和输出

工具定义向模型公开：

```json
{
  "type": "function",
  "function": {
    "name": "read_file",
    "description": "读取工作区内的 UTF-8 文本文件，不会修改文件。",
    "parameters": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "相对于工作区根目录的文件路径"
        }
      },
      "required": ["path"],
      "additionalProperties": false
    }
  }
}
```

调用参数只允许：

```json
{ "path": "README.md" }
```

成功结果：`ok: true`，`content` 为完整 UTF-8 文件文本；空文件是成功结果，content 为空字符串。失败结果：`ok: false`，`content` 为安全错误摘要。错误摘要不包含绝对路径、堆栈、密钥或未经限制的底层异常。

## 文件边界

- 根目录是 bootstrap 在启动时解析的当前工作目录。
- 只接受相对路径；空白、绝对路径和 `..` 越界路径拒绝。
- 先 `stat` 检查文件类型和字节大小：65536 字节允许，65537 字节拒绝。
- 通过真实路径按路径段比较符号链接，目标必须仍位于根目录内，避免 `/work` 和 `/workspace` 的前缀碰撞。
- 使用 `Buffer` 加 `new TextDecoder("utf-8", { fatal: true })` 解码；无效 UTF-8 必须失败，不能静默替换为 U+FFFD。
- 拒绝目录、特殊文件、超过 64 KiB 的文件和无效 UTF-8 内容。
- 工具只读，不创建、修改或删除文件。

失败属于工具结果，不直接让 AgentLoop 崩溃；模型可以看到失败并决定最终回答。工具执行本身的取消或不可恢复内部错误应交给 AgentLoop，按阶段 02 的模型错误边界结束命令。

## AgentLoop 终止规则

- 没有工具调用且 assistant 文本非空：成功结束。
- 有合法工具调用：执行全部调用，追加结果，再进行下一次模型调用。
- assistant 没有文本且没有合法工具调用：响应协议错误。
- 达到 `maxModelCalls`：循环上限错误，不再发起下一次模型请求；如果最后一次响应包含工具调用，这批工具也不执行。
- `maxModelCalls` 推荐默认值为 `8`，阶段 02 不暴露为 CLI 参数。
- 单个 assistant 响应最多允许 `4` 个工具调用；超过后产生 `protocol_error`，该批次一个调用也不执行。

AgentLoop 对外返回：

```ts
interface AgentLoopResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  // 阶段 02 只有 final_text；后续阶段可扩展为其他成功停止原因。
  stopKind: "final_text";
}
```

`AgentLoopResult` 只表示成功完成并得到最终文本。循环上限、工具批次协议错误、模型请求错误和取消都不返回 result，而是抛出相应的稳定错误；阶段 02 的循环和协议失败抛 `AgentLoopError`。

## 阶段 04 持久化事实交付（draft）

阶段 04 不把工具执行过程改成任意事件总线。持久化路径由 coordinator 为每个 turn 创建 `TurnExecutionContext`，把以下已校验事实按顺序交给 `TurnFactSink.record()`，并等待 `SessionWriter.appendDurable()` 完整写入和同步确认：

```text
user → assistant → tool_start → tool_result 或 tool_end → … → turn_end
```

每个 assistant 在 turn 内生成临时 `assistantId`（如 `a1`、`a2`）；工具事实携带同一响应的 `CallRef`。存储 adapter 将已确认的 `(turnId, assistantId)` 映射为文件中的 `callMessageSeq`，未知引用、重复 assistantId、调用名/ID 不一致或越序都是 `PersistenceError(contract_violation)`，不能猜测最近一条 assistant。

`tool_start` 确认后如果在进入注册表前收到取消，必须先保存 `tool_end`，其安全错误码为 `cancelled_before_dispatch`，确认后才结束业务 turn；注册表已经开始后按实际异常或取消原因保存结果。完整 `ToolResult` 已交付时只保存 `tool_result`，不能再为同一调用追加重复的 `tool_end`。

只有 coordinator 保存并确认 `turn_end(success)` 后，REPL 才提交 `StreamTurnResult.appendedMessages` 到内存历史。失败、取消、超时或保存故障不提交半截历史；保存故障原样穿透 core，不转成 `ok:false` 工具结果、协议错误或普通取消。普通 `--prompt` 不注入 sink，继续保持无会话副作用。

该扩展仍保留本文件前述的整批参数预检、顺序执行、4 个工具调用和 8 次模型调用上限；扩展接口、保存屏障、错误分类和恢复投影见[会话存储契约](session-store.md)。实现和验收完成前不得将本节的持久化行为当作已交付能力。

## OpenCode Go 映射

阶段 02 的 OpenAI 兼容请求需要在阶段 01 请求基础上按需增加 `tools` 字段：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "总结 README.md" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取工作区内的 UTF-8 文本文件，不会修改文件。",
        "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false }
      }
    }
  ],
  "stream": false
}
```

服务端响应中的 `choices[0].message.tool_calls` 必须转换为内部 `ToolCall[]`；每个调用至少包含 `id`、函数名和参数 JSON。`choices[0].finish_reason` 转换为内部 `finishReason` 并保留。发送 tool 消息时省略 `name`，只保留 `role`、`tool_call_id` 和 `content`。阶段 02 仍不处理流式工具调用，也不依赖提供方以外的原始字段。

`LlmRequest.tools` 是可选字段；当工具列表为空时，adapter 必须省略 JSON 中的 `tools` 字段，不能发送空数组。这样阶段 01 的请求体和测试保持兼容。

阶段 02 已同步更新 [LlmClient 契约](llm-client.md) 和 [OpenCode Go HTTP 契约](opencode-go-http.md)，并增加请求体和响应解析测试。阶段 01 的无工具请求仍应保持兼容。

## 关联文档

- [阶段 02 规格](../specs/phase-02-read-file-agent-loop.md)
- [阶段 01 LlmClient 契约](llm-client.md)
- [OpenCode Go HTTP 契约](opencode-go-http.md)

## 已实现代码与验证

- [tool.ts](../../src/contracts/tool.ts)、[agent.ts](../../src/contracts/agent.ts)：工具和循环公共数据。
- [toolRegistry.ts](../../src/core/toolRegistry.ts)：整批结构预检、参数解析和名称分派；结构错误抛 AgentLoopError，未知名称返回安全工具结果。
- [agentLoop.ts](../../src/core/agentLoop.ts)：历史与预算、顺序执行和结果；adapter 的结构/截断错误为 ResponseError，core 的批次/参数错误为 AgentLoopError。
- [ReadFileTool.ts](../../src/adapters/filesystem/ReadFileTool.ts)：路径、stat、受限读取与 fatal UTF-8 解码。采用 ignoreBOM:true 保留文件开头 BOM；读取后再次检查大小，文件增长不会静默截断成功。
- 文件错误摘要使用稳定前缀：invalid_arguments、invalid_path、outside_workspace、file_not_found、not_regular_file、file_too_large、invalid_utf8、permission_denied、read_failed；不拼接底层异常或绝对路径。
- 取消在操作前后和每次读取之间检查，同一个 signal 贯穿循环、注册表和工具；底层 stat/read 没有 OS 级抢占取消保证，已开始的文件调用完成后检查信号，拒绝继续追加成功结果。句柄在 finally 关闭。
- 真实路径检查不是操作系统沙箱，不承诺对父目录并发替换提供原子隔离；当前边界和大小限制测试结果见阶段规格。
- [agentLoop.test.ts](../../tests/agentLoop.test.ts)、[readFile.test.ts](../../tests/readFile.test.ts)、[toolHttp.test.ts](../../tests/toolHttp.test.ts)覆盖循环、工具和协议往返，CLI 子进程测试覆盖源码及产物入口。

## 阶段 03 流式复用

[streamAssembler.ts](../../src/core/streamAssembler.ts) 将每个 index 独立拼装成完整 ToolCall，message end 后整批复用 validateToolBatch；整条 stream 成功结束后才能调用 executeToolBatch。两种循环共用顺序执行器和 loopLimits，仍为 8 次模型、每批 4 项。任一协议错误、length、缺 message end 或取消都不执行未完成批次；流式失败不向 REPL 返回可提交的半截消息。验证入口见 [stream.test.ts](../../tests/stream.test.ts)。
