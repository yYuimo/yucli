# LlmClient 契约

状态：`accepted`

适用阶段：阶段 01 单次模型问答。

## 目的

`LlmClient` 是应用层与模型提供方之间的边界。应用层只构造 yucli 的消息和请求，不依赖 OpenCode Go 的响应结构；具体客户端负责 HTTP、认证、超时和响应校验。

## TypeScript 接口

```ts
export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LlmRequest {
  model: string;
  messages: Message[];
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResponse {
  message: {
    role: "assistant";
    content: string;
  };
  usage?: LlmUsage;
}

export interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
```

阶段 01 不在公共接口中暴露工具调用、流式 chunk、提供方专属字段或原始 HTTP 响应。

代码位置：数据结构在 `src/contracts/message.ts`，`LlmClient` 与稳定错误在 `src/contracts/llm-client.ts`。`core/runPrompt.ts` 只依赖这两个契约模块；`adapters/opencode-go/OpenCodeGoClient.ts` 实现接口，并自行声明构造参数类型，不依赖配置加载器。

## 调用约定

- `messages` 保持调用方给出的顺序。
- 阶段 01 只传入 `system`、`user` 和 `assistant` 消息；默认应用不主动添加 system message。
- 客户端不得修改调用方传入的请求对象或消息数组。
- `complete()` 成功时必须返回一个 role 为 `assistant`、content 非空白的文本，保留原始空格和换行。可选 token 用量存在时必须为非负整数。
- `complete()` 失败时抛出 yucli 定义的稳定错误类型，不把 HTTP 库原始异常直接暴露给应用层。
- `signal` 存在时，客户端将其取消事件转发给内部控制器，与超时合并后把内部 signal 传给 `fetch`；取消后不得继续把结果当作成功响应返回。

## OpenCode Go 适配

本节为适配摘要。HTTP 地址、headers/body、完整请求响应示例、字段映射和错误处理流程统一见 [OpenCode Go HTTP 接口契约](opencode-go-http.md)。本文继续定义 core 与 adapter 之间的内部接口，两份契约须同步维护。

阶段 01 的实现为 `OpenCodeGoClient`，使用以下配置：

```text
OPENCODE_GO_API_KEY       必填
OPENCODE_GO_BASE_URL      默认 https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL         默认 deepseek-v4-flash
YUCLI_REQUEST_TIMEOUT_MS  默认 120000
```

请求：

```http
POST {trimRight(baseUrl, "/")}/chat/completions
Authorization: Bearer <api-key>
Content-Type: application/json
x-opencode-session: <每次请求独立的 UUID>
```

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "stream": false
}
```

响应只读取：

```text
choices[0].message.role
choices[0].message.content
usage.prompt_tokens
usage.completion_tokens
```

`x-opencode-session` 是 OpenCode Go 的必需路由扩展，由适配器使用 `randomUUID()` 逐次生成，不放入公共请求对象或模型消息。阶段 01 每次请求即一次独立问答；未来多轮会话需要重新设计其生命周期，见 [ADR-002](../decisions/ADR-002-opencode-session-routing.md)。

`reasoning_content` 不作为阶段 01 的最终输出。未知字段允许存在；必需字段缺失或类型不正确时拒绝响应。

## 错误契约

应用层至少能区分以下错误类别：

| 类别 | 发生位置 | 应用层行为 |
| --- | --- | --- |
| `ConfigError` | 请求开始前 | 显示缺失配置，返回配置错误退出码 |
| `RequestError` | 网络、超时或 HTTP 非 2xx | 显示安全的请求错误，返回模型错误退出码 |
| `ResponseError` | 2xx 响应不符合协议 | 显示响应解析错误，返回模型错误退出码 |
| `AbortError` | 调用方取消请求 | 阶段 01 显示取消信息并返回非零退出码 |

非 2xx 响应体最多读取 512 字节作为诊断摘要；脱敏已知 API key（包括截断处的前缀）和 Authorization/Bearer 内容，去除控制字符，再将摘要限制到 512 字节。错误消息不暴露底层异常或原始响应。客户端不跟随 HTTP 重定向。

`RequestError.code` 为 `network`、`timeout` 或 `http`；可用时附带 `status`，HTTP 错误附带已脱敏的 `responseSummary`。调用方取消使用 `AbortError`，CLI 将其映射为退出码 4。

## 生命周期与资源

- 每次 `complete()` 使用一次独立的请求和超时 signal；超时覆盖连接和整个响应体读取，外部取消与超时以先触发者为准。
- 请求结束、失败或取消后，定时器和监听器必须清理。
- 阶段 01 不维护连接池、会话状态或重试队列。
- 客户端不负责输出、不写文件、不保存消息历史。

## 兼容性边界

这个契约只依赖 OpenAI Chat Completions 的最小公共字段。若后续加入流式、工具调用或提供方扩展，应新增字段和测试，并在阶段文档或 ADR 中记录兼容性影响，不能静默改变 `complete()` 的语义。

关联文档：[阶段 01 规格](../specs/phase-01-single-model.md)。
