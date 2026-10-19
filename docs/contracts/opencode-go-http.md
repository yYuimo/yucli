# OpenCode Go HTTP 接口契约

状态：`accepted`

阶段 02 扩展状态：`accepted`

阶段 03 流式扩展状态：`draft`

适用阶段：阶段 01 单次、非流式文本问答；阶段 02 非流式工具调用往返；阶段 03 SSE 流式文本和工具调用。

本文约定 yucli 怎样调用 OpenCode Go、怎样把其响应转换为内部结果。内容依据当前实现、已有本地 HTTP 测试和阶段 01/02 真实联调记录，不代表 OpenCode Go 的完整官方 API 规范。本文中的请求、响应数据均为说明用示例，不包含真实凭证或真实回答。

## 调用双方与职责

| 参与方 | 做什么 | 输入与输出 |
| --- | --- | --- |
| `bootstrap/cli.ts` | 检查参数、加载配置、注册 read_file、输出最终文本 | `--prompt` → `agentLoop(...)` → stdout 或 stderr |
| `core/agentLoop.ts` | 创建初始消息、整批校验工具、顺序执行并保存历史 | prompt → 多次 `LlmRequest` → `AgentLoopResult` |
| `OpenCodeGoClient.complete()` | 将内部请求发往 OpenCode Go，处理 HTTP 和响应校验 | `LlmRequest` → `Promise<LlmResponse>`，失败则拒绝 Promise |
| OpenCode Go 服务 | 接收模型名与消息，返回 Chat Completions 响应 | HTTP JSON 请求 → HTTP 状态与响应体 |

`LlmRequest`、`LlmResponse` 是项目内部的数据结构；HTTP 请求和响应是双方在网络上传输的数据格式。它们通过 adapter 转换，core 不需要访问服务端的 `choices` 数组。阶段 02 的工具往返仍由 adapter 完成 OpenAI 兼容字段转换，AgentLoop 只接收内部工具调用。

```mermaid
sequenceDiagram
    participant CLI as CLI
    participant Loop as AgentLoop
    participant Client as OpenCodeGoClient
    participant Go as OpenCode Go
    participant Tool as ReadFileTool
    CLI->>Loop: client、registry、model、prompt
    Loop->>Client: user 消息与工具定义
    Client->>Go: POST，新的 session UUID
    Go-->>Client: assistant tool_calls
    Client-->>Loop: 内部 ToolCall 与 finishReason
    Loop->>Loop: 整批结构预检及调用预算检查
    Loop->>Tool: 顺序读取工作区内文件
    Tool-->>Loop: 内容或安全错误摘要
    Loop->>Client: user + assistant + tool 完整历史
    Client->>Go: POST，另一个 session UUID
    Go-->>Client: 最终 assistant 文本
    Client-->>Loop: LlmResponse
    Loop-->>CLI: AgentLoopResult.finalText
    CLI->>CLI: stdout 输出并结束
```

## 从终端输入到模型消息

例如执行：

```bash
pnpm dev --prompt "解释一下 Promise"
```

CLI 先确认 prompt 非空白，再加载配置。阶段 02 的 AgentLoop 创建初始 user 消息并附加注册工具；阶段 01 保留的 `runPrompt` 仍可生成下面的无工具请求：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "解释一下 Promise" }
  ]
}
```

`model` 来自 `OPENCODE_GO_MODEL` 或默认值；`content` 保留用户输入原文，包括其中的空格和换行。阶段 01 不主动添加 system message，也不附加过去问答或项目文件。

内部接口允许 `system`、`user`、`assistant` 纯文本消息；adapter 按调用方给出的消息顺序发送，不修改请求对象。当前 adapter 信任内部 TypeScript 契约，不额外对传入的 `LlmRequest` 做完整运行时校验；阶段 02 CLI 以一条 user 消息开始，再由 AgentLoop 添加 assistant 调用和 tool 结果。

## HTTP 请求契约

### 地址与方法

```text
POST {去掉末尾斜线的 baseUrl}/chat/completions
```

默认完整地址为：

```text
https://opencode.ai/zen/go/v1/chat/completions
```

`baseUrl` 来自 `OPENCODE_GO_BASE_URL`。配置加载器只允许无内嵌凭证、查询参数和片段的 HTTP(S) URL。客户端不请求 `/models`，不自动跟随重定向，也不重试请求。

### 请求头：认证和路由

```http
Authorization: Bearer <api-key>
Content-Type: application/json
x-opencode-session: <本次请求的随机 UUID>
```

| 字段 | 值从哪里来 | 用途 |
| --- | --- | --- |
| `Authorization` | `OPENCODE_GO_API_KEY`，由配置模块读取后传给客户端 | 向服务端认证；密钥不放入消息、JSON body 或 URL |
| `Content-Type` | adapter 固定设置 | 告诉服务端 body 是 JSON |
| `x-opencode-session` | 每次 `complete()` 内调用 `randomUUID()` | 提供服务路由标识；不代表本地已保存会话或服务会自动补齐历史 |

阶段 01 首次真实请求因缺少路由头返回 HTTP 400 `MissingSessionID`，补充后成功，依据见 [ADR-002](../decisions/ADR-002-opencode-session-routing.md)。阶段 01 每次调用独立问答；阶段 02 同一次命令的各轮请求仍使用独立 UUID，已在真实工具往返中验证；结果见 ADR-002。

上表列的是客户端显式设置的应用请求头，底层 fetch 还可能自动生成传输所需的请求头。

### 请求体：模型要看到的信息

adapter 从内部请求取出 `model` 和 `messages`，有非空工具定义时加入 `tools`，并额外加入 `stream: false`：

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "解释一下 Promise" }
  ],
  "stream": false
}
```

对应实现中的关键代码：

```ts
body: JSON.stringify({
  model: request.model,
  messages: request.messages.map(toWireMessage),
  ...(request.tools?.length ? {
    tools: request.tools.map((tool) => ({ type: "function", function: tool })),
  } : {}),
  stream: false,
}),
```

`JSON.stringify` 将 JavaScript 对象变成 JSON 文本，fetch 把文本放入 HTTP body。TypeScript 接口只帮助本地编译检查，不会自动把对象发送出去；实际传输由 `fetch(...)` 完成。

| 请求体字段 | 规则 |
| --- | --- |
| `model` | 要调用的模型标识，默认 `deepseek-v4-flash` |
| `messages` | 有序消息数组；阶段 02 可包含 assistant 工具调用和 tool 结果 |
| `tools` | 阶段 02 可选的工具定义；为空时省略，不发送空数组 |
| `stream` | 固定为 `false`，本阶段读取完整 JSON 回答 |

阶段 01 不发送工具声明；阶段 02 只发送已注册的 `read_file` 工具定义。本阶段不发送 temperature、response format 等字段。认证密钥、超时值和 AbortSignal 均不进入请求体；AbortSignal 用于本地取消网络操作。

阶段 02 有工具时的请求体还包含：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取工作区内的 UTF-8 文本文件，不会修改文件。",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

`tools` 为空或未提供时必须从 JSON 请求体中省略；不能发送空数组，否则阶段 01 的无工具请求契约会发生变化。模型返回的 tool 消息发回服务时只包含 `role: "tool"`、`tool_call_id` 和 `content`，阶段 02 省略可选的 `name` 字段。

## 成功响应与内部转换

### 服务端返回的结构

HTTP 2xx 响应示例：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Promise 表示一个异步操作的最终结果。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 18
  }
}
```

其他字段可以存在，但阶段 01/02 只提取下表中的字段：

| 服务端字段 | 检查与处理 | 内部字段 |
| --- | --- | --- |
| `choices[0].message.role` | 必须为 `assistant` | `message.role` |
| `choices[0].message.content` | 阶段 01 必须是非空白字符串；阶段 02 可缺失或为 null，但必须和合法 tool calls 至少满足一项 | `message.content` |
| `choices[0].message.tool_calls` | 阶段 02 可选；每个调用必须有非空 id、函数名和参数 JSON | `message.toolCalls` |
| `choices[0].finish_reason` | 存在时保留；`length` 直接产生 `ResponseError`，不执行工具 | `finishReason` |
| `usage.prompt_tokens` | 存在时必须为非负安全整数 | `usage.inputTokens` |
| `usage.completion_tokens` | 存在时必须为非负安全整数 | `usage.outputTokens` |

只取第一条 choice，不合并其他候选答案。`usage` 可以缺失；存在时必须是非 null、非数组对象。两个 token 字段可以分别缺失，缺失不等于用量为 0；例如 `usage: {}` 会转换成空用量对象。

阶段 01 历史实现只提取文本。阶段 02 已保留 `finish_reason`，允许“非空文本或至少一个合法工具调用”作为成功响应；两者都没有时仍是 `ResponseError`。`finish_reason: "length"` 无论是否有工具调用都直接失败。

### 响应按什么顺序处理

1. `await fetch(...)` 得到 Response，先检查 `response.ok` 是否为 true，即 HTTP 状态在 200—299。
2. 对成功状态调用 `await response.text()` 读完响应体。拿到响应头不等于回答已经读完；这一段也受超时和取消控制。
3. 调用 `controller.signal.throwIfAborted()` 再次检查取消状态。
4. `JSON.parse(body)` 把 JSON 文本转成 JavaScript 数据。语法不合法则产生 `ResponseError`。
5. `parseResponse(parsed)` 校验上述业务字段并构造内部结果。给数据写类型断言不会代替这一步校验。
6. 返回 `LlmResponse`，经 runPrompt 或 AgentLoop 交给调用方；阶段 01 CLI 输出 `result.message.content`，阶段 02 AgentLoop 在工具往返完成后输出最终文本并追加换行。

当前实现不检查成功响应的 Content-Type，而是直接尝试解析 JSON；成功响应体没有应用层长度上限。512 字节限制只适用于失败响应的诊断摘要。

上述示例转换成：

```json
{
  "message": {
    "role": "assistant",
    "content": "Promise 表示一个异步操作的最终结果。"
  },
  "usage": {
    "inputTokens": 12,
    "outputTokens": 18
  },
  "finishReason": "stop"
}
```

CLI 最后只向 stdout 输出回答文本，退出码为 0。用量统计保留在结果对象中，当前 CLI 不展示；原始响应、reasoning 和认证信息不进入正常输出。

## 失败怎样传回 CLI

`complete` 是 async 方法。它内部的 throw 会使返回的 Promise 拒绝；AgentLoop 不将该失败当成 tool 结果，最终由 CLI 的 `await` / `catch` 接住，不会把错误当作模型回答。

| 情况 | adapter 或配置层的处理 | CLI 结果 |
| --- | --- | --- |
| 密钥缺失、端点或超时非法 | 请求前抛 `ConfigError` | stderr，退出码 3 |
| 连接失败、发送失败、响应体传输中断 | `RequestError`，code 为 `network` | stderr，退出码 4 |
| 超时首先触发 | `RequestError`，code 为 `timeout` | stderr，退出码 4 |
| 调用方取消首先触发 | `AbortError` | stderr，退出码 4 |
| HTTP 非 2xx | 读有限摘要，抛 `RequestError`，code 为 `http` | stderr，退出码 4 |
| HTTP 2xx，但不是有效 JSON | `ResponseError` | stderr，退出码 4 |
| JSON 有效，但回答、工具调用字段、finish_reason 或用量字段不符合契约 | adapter 抛 `ResponseError` | stderr，退出码 4 |
| 工具参数 JSON/字段非法、批次过大或 ID 不合法 | core 预检抛 `AgentLoopError(protocol_error)` | stderr，退出码 4 |
| 第 8 次响应仍有工具调用 | 不执行最后一批，抛 `AgentLoopError(loop_limit)` | stderr，退出码 4 |

例如服务端返回 HTTP 400 和下面的响应体：

```json
{
  "type": "error",
  "error": {
    "type": "MissingSessionID",
    "message": "Request is missing x-opencode-session"
  }
}
```

客户端根据 HTTP 状态进入失败分支，不执行正常回答解析，也不依赖 `error.type` 这样的提供方字段来分类。它读取最多 512 字节用于诊断，遮盖已知密钥、截断处密钥前缀和 Authorization/Bearer 内容，去除控制字符，再限制摘要为最多 512 字节。

`RequestError` 保留稳定的 code、说明和已获得的 status；正常读完失败摘要时也保留 responseSummary。若失败响应体本身读取超时或中断，则按 timeout/network 处理，已取得的 HTTP 状态仍可附带。重定向被 fetch 拒绝，当前按 network 分类，不保证提供重定向的状态码。

## 超时、取消和资源归属

超时来自 `YUCLI_REQUEST_TIMEOUT_MS`，默认 120000 毫秒，配置允许 1—2147483647 的整数。每次调用独立创建 AbortController、定时器和外部 signal 的监听器。

- 超时与外部取消都触发内部控制器，fetch 接收内部 signal；外部 AbortSignal 本身不会被发送给服务端。
- 内部只记录第一次取消原因，避免超时和调用方取消互相覆盖。
- 定时器覆盖请求和响应体读取；读取结束前不会因拿到响应头而撤销超时。
- complete 的 finally 清理定时器和外部监听器；错误摘要读取的 finally 取消剩余读取并释放 reader 锁。
- 取消代表本地停止等待/读取，不保证服务端已停止推理或撤销费用。当前 CLI 不提供额外取消交互，接口级取消能力供调用方和测试使用。

## 验证依据与兼容性

| 检查范围 | 对应位置 |
| --- | --- |
| 请求 URL、headers、路由 UUID、body 和响应映射 | [client.test.ts](../../tests/client.test.ts) |
| HTTP/网络错误、错误摘要、响应非法、超时和取消 | [client.test.ts](../../tests/client.test.ts) |
| 配置优先级、默认值与非法值 | [config.test.ts](../../tests/config.test.ts) |
| 源码/产物 CLI 的 stdout、stderr 和退出码 | [cli.test.ts](../../tests/cli.test.ts) |
| 真实服务路由要求和成功调用记录 | [阶段 01](../specs/phase-01-single-model.md)、[ADR-002](../decisions/ADR-002-opencode-session-routing.md) |

测试覆盖范围以各测试实际断言为准，不能将本文所有说明都理解为已有独立测试。阶段 02 新增循环、文件工具与 HTTP 往返测试；最近一次真实验证结果见下文。

阶段 02 的工具往返需要在真实服务中验证：一次命令的多次 HTTP 请求各自使用新的 `x-opencode-session` 是否仍能完成工具调用和最终回答；结果回写 [ADR-002](../decisions/ADR-002-opencode-session-routing.md) 与 [阶段 02 ADR](../decisions/ADR-003-phase-02-minimal-agent-loop.md)。阶段 03 的 SSE 扩展见本文末尾和[流式模型与 SSE 契约](streaming.md)。后续加入重连或不同模型协议时，必须同步修改本文、[LlmClient 契约](llm-client.md)、adapter 和相应测试；提供方路由 ID 的生命周期变化也需要更新 ADR。

源码入口：[runPrompt.ts](../../src/core/runPrompt.ts)、[OpenCodeGoClient.ts](../../src/adapters/opencode-go/OpenCodeGoClient.ts)、[cli.ts](../../src/bootstrap/cli.ts)。

## 阶段 03 SSE 流式映射（draft）

阶段 03 在相同 URL、认证头和 `x-opencode-session` 规则上发送 `stream: true`。响应体按 SSE 事件读取；adapter 不把原始 chunk 暴露给 core，而是产生 [流式契约](streaming.md) 中的 `text_delta`、`tool_call_delta`、`message_end` 和 `usage` 事件。

```json
{
  "model": "deepseek-v4-flash",
  "messages": [{ "role": "user", "content": "总结 README.md" }],
  "tools": [{ "type": "function", "function": { "name": "read_file", "description": "读取工作区文件", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } } }],
  "stream": true
}
```

每个 SSE `data` JSON 的 `choices[0].delta.content` 转成文本事件；`delta.tool_calls[*]` 按 `index` 转成工具调用 delta；最后一个 choice 的 `finish_reason` 转成 message end。`[DONE]` 只结束传输，不能替代缺失的 message end。`finish_reason: "length"`、非法 JSON、半截 UTF-8、缺少收尾或连接中断均抛 `ResponseError`，不执行工具。

阶段 03 的多轮请求仍按阶段 02 规则每次 `complete()`/`stream()` 生成独立 `x-opencode-session`；真实联调需要确认服务支持连续流式工具往返。

## 阶段 02 工具消息完整映射示例

模型返回（工具参数是 JSON 字符串，尚未信任）：

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant", "content": null,
      "tool_calls": [{
        "id": "call-1", "type": "function",
        "function": { "name": "read_file", "arguments": "{\"path\":\"README.md\"}" }
      }]
    }
  }]
}
```

adapter 转换为 `message.toolCalls: [{id,name,argumentsJson}]`，null content 规范化为空字符串，并保留 `finishReason: "tool_calls"`。这里先检查外层字段；AgentLoop 随后在执行任何一项前解析整批参数，确保每项恰好包含字符串 path。名称非空但未知属于可恢复执行错误。

读取成功后下一次请求的 messages 为：

```json
[
  { "role": "user", "content": "总结 README.md" },
  {
    "role": "assistant", "content": "",
    "tool_calls": [{
      "id": "call-1", "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"README.md\"}" }
    }]
  },
  { "role": "tool", "tool_call_id": "call-1", "content": "示例文件正文" }
]
```

该请求仍带同一组工具定义，且产生新的 session UUID；消息不带 finishReason，tool 消息不带 name 或 ok。失败工具通过安全 content 前缀告知模型，详细 ok/name 状态留在本地 ToolResult。模型返回最终非空文本后，AgentLoop 返回成功结果，CLI 输出 finalText。

## 阶段 02 真实验证结果

2026-10-19，使用项目工具链运行构建产物 CLI，prompt 只要求读取 README.md 并总结。两次请求均为 deepseek-v4-flash、HTTP 200；finish_reason 依次为 tool_calls、stop；第二次请求角色顺序为 user/assistant/tool，工具结果与调用 ID 配对。两次 x-opencode-session 各自不同，CLI 退出码 0，stdout 非空、stderr 为空，约 8.07 秒。临时观测器只提取协议元数据，未保存密钥、文件正文或完整回答。

本次验证支持当前账号、端点和模型下的逐请求 UUID 策略，不代表服务承诺所有模型的永久兼容性。
