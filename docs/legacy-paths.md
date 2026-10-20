# 非主流程代码清单（历史与降级路径）

状态：维护中

更新日期：2026-10-19

本文件记录**当前不在 CLI 主流程中运行**的代码：它们的角色、仍依赖它们的测试或契约、保留原因，以及删除或恢复的条件。它不是 API 文档，而是"代码去留的账本"，用于防止两类错误：

- 误删仍有兼容/测试价值的路径；
- 长期无人使用却无人清理，最终漂移成事实上的死代码。

## 1. 什么算"主流程"

主流程指用户实际运行 `yucli` 或 `yucli --prompt` 时经过的代码路径：

```text
bootstrap/cli.ts
  ├─ --prompt：bootstrap/output.ts displayTurn
  │              → core/runTurnStream
  │              → adapters/opencode-go/stream() → SseParser / streamChunk
  │              → core/streamAssembler
  │              → core/toolRegistry → adapters/filesystem/ReadFileTool
  └─ 无参数：  bootstrap/repl.ts
                 → bootstrap/output.ts displayTurn → 同上
```

不经过以上路径、但仍属于源码或测试依赖的代码，记录在本文件。

## 2. 当前清单

| 代码 | 位置 | 当前角色 | 仍被谁使用 | 保留原因 | 删除或恢复条件 |
| --- | --- | --- | --- | --- | --- |
| `agentLoop()` | `src/core/agentLoop.ts` | 非流式 ReAct 循环；兼容/测试路径 | `tests/agentLoop.test.ts`、`tests/toolHttp.test.ts` | 阶段 01/02 的回归基线；流式不兼容或不可用时的退路 | 仅在项目明确放弃非流式能力时删除（需阶段文档与 ADR）；恢复生产使用需新增入口（如 `--no-stream`）并更新本表 |
| `runPrompt()` | `src/core/runPrompt.ts` | 阶段 01 的单次问答封装 | `tests/client.test.ts` | 保持 `complete()` 路径的最小调用样例与兼容层 | 可随非流式路径一并删除 |
| `OpenCodeGoClient.complete()` | `src/adapters/opencode-go/OpenCodeGoClient.ts` | 非流式 HTTP 请求、响应校验与消息映射 | `agentLoop`、`runPrompt`、`tests/client.test.ts`、`tests/toolHttp.test.ts` | 同上；与 `stream()` 共用 `toWireMessage` 等映射，保留成本低 | 非流式能力整体移除时删除 |
| `parseResponse()`（私有） | `src/adapters/opencode-go/OpenCodeGoClient.ts` | 非流式响应的解析与校验 | 仅被 `complete()` 调用 | 属于 `complete()` 路径的组成部分 | 随 `complete()` 删除 |
| `LlmClient.complete()`（契约） | `src/contracts/llm-client.ts` | 非流式模型调用接口 | `agentLoop`（`Pick<LlmClient, "complete">`）、`runPrompt`、测试 | 契约兼容；未来 SDK/嵌入方可能只需要非流式 | 需要契约变更并新增 ADR |
| `LlmResponse` 类型 | `src/contracts/message.ts` | `complete()` 的返回类型 | 同上 | 契约兼容 | 随 `complete()` 契约移除 |

说明：

- 上述条目中的"测试"不是历史包袱，而是这些路径的**安全网**；删除代码时应同步删除或替换测试，不能先删测试。
- 本清单只记录"曾属于生产、或可能回到生产"的代码；普通测试辅助、构建脚本、模板文件不在此列。

## 3. 与主流程共享、不要误删

以下内容虽然出现在非流式代码附近，但阶段 03 的主流程仍在使用：

| 代码 | 仍被谁使用 |
| --- | --- |
| `AgentLoopOptions` / `AgentLoopResult` | `runTurnStream`、`StreamTurnResult`（`extends AgentLoopResult`） |
| `resolveLoopLimits()`（`core/loopLimits.ts`） | `agentLoop` 与 `runTurnStream` 共用 8/4 上限校验 |
| `executeToolBatch()` / `validateToolBatch()`（`core/toolRegistry.ts`） | 两条循环共用 |
| `toWireMessage()`、工具与消息契约 | `complete()` 与 `stream()` 共用 |

## 4. 维护规则

1. **新增**：任何代码退出主流程时，在本表加一行，写明位置、角色、使用方、保留原因和去留条件。
2. **主流程变化**：入口、调用链或阶段范围变化后，检查本表是否仍然准确。
3. **删除**：先确认没有生产代码、测试或契约依赖；按阶段规范更新契约与 ADR，再同步本表。
4. **恢复**：路径回到主流程时，更新本表并注明恢复原因；不要只删表格行。
5. **阶段收尾**：每个阶段完成时顺手核对一次；本表与 `docs/README.md` 入口保持同步。

## 5. 自检命令

以下命令用于快速核对引用关系；注释中的提及也会出现在结果中，需要人工区分：

```bash
# 当前主流程相关文件（入口、渲染、流式循环）
grep -rn "runTurnStream\|displayTurn\|runRepl" src

# 非主流程相关引用（应与本表一致）
grep -rn "agentLoop\|runPrompt\|\.complete(" src tests
```

## 6. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-19 | 初版：阶段 03 的 CLI 全部切到 `stream()` 后，`complete()`、`agentLoop`、`runPrompt` 退出主流程；记录为兼容/测试/降级路径 |
