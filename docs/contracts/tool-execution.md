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

interface ToolResult {
  toolCallId: string;
  name: string;
  ok: boolean;
  content: string;
}

interface ToolDefinition {
  name: "read_file";
  description: string;
  parameters: {
    type: "object";
    properties: {
      path: { type: "string" };
    };
    required: ["path"];
    additionalProperties: false;
  };
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
tool：tool_call_id、name、content
```

AgentLoop 必须按以下顺序追加消息：

1. 初始 user 消息。
2. 模型返回的 assistant 消息，保留文本和完整工具调用。
3. 每个工具调用对应一个 tool 消息，`tool_call_id` 必须匹配。
4. 下一次模型请求使用完整历史和同一组工具定义。

工具结果不能替换 assistant 工具调用，也不能只把文件内容拼接进下一条 user 消息。这样模型可以区分“模型请求了什么”和“工具实际返回了什么”。

一次 assistant 响应可以有多个调用；阶段 02 顺序执行，并按调用顺序追加结果。调用 ID 在同一响应中必须唯一且非空。

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

成功结果：`ok: true`，`content` 为完整 UTF-8 文件文本。失败结果：`ok: false`，`content` 为安全错误摘要。错误摘要不包含绝对路径、堆栈、密钥或未经限制的底层异常。

## 文件边界

- 根目录是 bootstrap 在启动时解析的当前工作目录。
- 只接受相对路径；空白、绝对路径和 `..` 越界路径拒绝。
- 通过真实路径检查符号链接，目标必须仍位于根目录内。
- 拒绝目录、特殊文件、超过 64 KiB 的文件和无效 UTF-8 内容。
- 工具只读，不创建、修改或删除文件。

失败属于工具结果，不直接让 AgentLoop 崩溃；模型可以看到失败并决定最终回答。工具执行本身的取消或不可恢复内部错误应交给 AgentLoop，按阶段 02 的模型错误边界结束命令。

## AgentLoop 终止规则

- 没有工具调用且 assistant 文本非空：成功结束。
- 有合法工具调用：执行全部调用，追加结果，再进行下一次模型调用。
- assistant 没有文本且没有合法工具调用：响应协议错误。
- 达到 `maxModelCalls`：循环上限错误，不再发起下一次模型请求。
- `maxModelCalls` 推荐默认值为 `8`，阶段 02 不暴露为 CLI 参数。

## OpenCode Go 映射

阶段 02 的 OpenAI 兼容请求需要在阶段 01 请求基础上增加 `tools` 字段：

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

服务端响应中的 `choices[0].message.tool_calls` 必须转换为内部 `ToolCall[]`；每个调用至少包含 `id`、函数名和参数 JSON。阶段 02 仍不处理流式工具调用，也不依赖提供方以外的原始字段。

阶段 02 实现前必须同步更新 [LlmClient 契约](llm-client.md) 和 [OpenCode Go HTTP 契约](opencode-go-http.md)，并增加请求体和响应解析测试。阶段 01 的无工具请求仍应保持兼容。

## 关联文档

- [阶段 02 规格](../specs/phase-02-read-file-agent-loop.md)
- [阶段 01 LlmClient 契约](llm-client.md)
- [OpenCode Go HTTP 契约](opencode-go-http.md)
