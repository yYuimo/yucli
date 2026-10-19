# 工具执行契约

状态：`draft`

适用阶段：阶段 02，只读 `read_file` 与最小 Agent Loop。

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

`argumentsJson` 保留模型原始参数文本；工具实现必须先 `JSON.parse`，再检查对象、字段类型和允许字段。TypeScript 类型断言不能替代这个运行时检查。

## 消息历史规则

阶段 02 的模型消息扩展为：

```text
user：content
assistant：content 或 tool_calls
tool：tool_call_id、content（内部结果另行保留工具名）
```

AgentLoop 必须按以下顺序追加消息：

1. 初始 user 消息。
2. 模型返回的 assistant 消息，保留文本、完整工具调用和 `finishReason`。
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

阶段 02 实现前必须同步更新 [LlmClient 契约](llm-client.md) 和 [OpenCode Go HTTP 契约](opencode-go-http.md)，并增加请求体和响应解析测试。阶段 01 的无工具请求仍应保持兼容。

## 关联文档

- [阶段 02 规格](../specs/phase-02-read-file-agent-loop.md)
- [阶段 01 LlmClient 契约](llm-client.md)
- [OpenCode Go HTTP 契约](opencode-go-http.md)
