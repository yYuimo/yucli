# ADR-001：使用 OpenCode Go OpenAI 兼容接口和原生 fetch

状态：`accepted`

日期：2026-10-17

关联阶段：阶段 01 单次模型问答。

## 背景与决定

yucli 第一阶段需要尽快验证完整的“终端输入 → 模型请求 → 终端输出”路径。当前 `.env` 已有 OpenCode Go 的端点和密钥配置，目标模型在本地 OpenCode 日志和已有实现中使用 `deepseek-v4-flash` 标识。

采用 OpenCode Go 的 OpenAI 兼容接口，并使用 Node 24 原生 `fetch` 发送请求。请求直接发送到 `{baseUrl}/chat/completions`，客户端自己处理认证、超时、状态码和响应校验。

模型默认值为 `deepseek-v4-flash`，端点和密钥从环境变量读取。

## 理由

- 当前目标是学习请求、响应和错误边界，原生 `fetch` 让这些边界可见。
- Node 24 已提供稳定的 `fetch` 和 `AbortController`，不需要额外 HTTP 运行时依赖。
- OpenCode Go 已证明可通过 Chat Completions 协议调用，现有 `.env` 可以直接复用。
- 不依赖 `/models` 发现接口；该端点探测返回 403，模型名由配置默认值提供。
- 客户端自己维护响应校验和错误转换，这部分代码通过契约测试覆盖。

## 影响

- 第一阶段运行时依赖只有 `commander` 和 `dotenv`，HTTP 使用 Node 原生能力。
- `LlmClient` 保持提供方无关，OpenCode Go 具体逻辑集中在 `OpenCodeGoClient`。
- 后续加入其他提供方时，可以新增适配器，不改变应用层消息和调用方式。
- 真实联调发现服务额外要求 `x-opencode-session` 路由头，适配器处理方式见 [ADR-002](ADR-002-opencode-session-routing.md)。
- 如果 OpenCode Go 的模型标识或协议发生变化，需要更新适配器、契约测试和本 ADR 的影响说明。

## 关联文件

- [LlmClient 契约](../contracts/llm-client.md)
- [CLI 契约](../contracts/cli.md)
- [阶段 01 规格](../specs/phase-01-single-model.md)
