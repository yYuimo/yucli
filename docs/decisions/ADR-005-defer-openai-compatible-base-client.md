# ADR-005：暂不抽取 OpenAI 兼容客户端基类

状态：`accepted`

## 背景与问题

阶段 03 要在 `OpenCodeGoClient` 中加入 SSE、流式工具调用和取消收尾。参考 `paicli-ts` 已有 `BaseLlmClient/OpenAICompatibleClient` 分层，但 yucli 目前只有一个真实提供方；过早抽取基类会同时改变构造、错误、超时和测试边界。

## 决定

阶段 03 继续由 `adapters/opencode-go/OpenCodeGoClient.ts` 实现 `complete()` 和 `stream()`，只提取 adapter 内部的私有 SSE/响应解析函数，不新增 `adapters/openai-compatible/` 基类。阶段 03 不改变 contracts 的 provider-neutral 边界。

## 理由与取舍

当前没有第二个提供方来验证抽象是否稳定；抽基类会让本阶段同时引入继承、模板方法和流式协议，增加理解与验证负担。保留一个具体 adapter 更容易追踪请求、响应和资源清理。代价是未来第二个提供方可能出现重复代码；届时以真实重复协议为依据抽取，并新增 ADR，而不是预留空抽象。

## 影响

- 阶段 03 只修改 OpenCode Go adapter 及其测试。
- `contracts` 不依赖 OpenAI/OpenCode 命名。
- 新增 provider 时重新评估共享 SSE、错误和认证边界。

## 关联阶段、契约和代码

- [阶段 03 规格](../specs/phase-03-repl-streaming.md)
- [流式模型与 SSE 契约](../contracts/streaming.md)
- [OpenCode Go HTTP 契约](../contracts/opencode-go-http.md)
