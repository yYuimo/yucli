# 阶段 02：只读文件工具与最小 Agent Loop

状态：`implementing`

本阶段建立在阶段 01 的单次模型问答之上。用户仍然从命令行提供一个 prompt，但模型可以提出 `read_file` 工具调用；yucli 执行一次只读文件操作，把工具结果加入消息历史，再让模型继续生成最终回答。

本阶段先完成一条可以观察的工具循环，不引入持续会话、流式输出、文件写入或命令执行。阶段设计中的推荐选择在用户修改前作为开发依据；实现开始前，阶段状态应改为 `designed`，并同步确认相关契约。

## 目标场景

用户执行：

```bash
yucli --prompt "请读取 README.md，并用三句话总结它"
```

模型发现需要文件内容时，返回一个 `read_file` 调用。yucli 执行工具、把结果传回模型，最后输出模型的文本回答：

```text
终端 prompt
  → CLI 组装初始 user 消息
  → AgentLoop 调用 LlmClient
  → 模型返回 assistant tool call
  → ReadFileTool 读取工作区内文件
  → 追加 assistant tool call 与 tool result
  → AgentLoop 再次调用 LlmClient
  → 模型返回最终 assistant 文本
  → CLI 输出并结束进程
```

## 范围

### 包含

- 在阶段 01 的四层单包结构中增加工具和循环能力。
- 增加 `ToolCall`、`ToolResult`、工具定义和工具执行器契约。
- 增加一个只读 `read_file` 工具，读取当前工作区内的 UTF-8 文本文件。
- 让 OpenCode Go 请求携带工具定义，并解析 assistant 的 `tool_calls`。
- 由 `AgentLoop` 顺序处理模型响应和工具调用，直到得到最终文本或触发边界。
- 对工具名称、参数 JSON、文件路径、文件大小和读取错误进行运行时校验。
- 用本地 mock HTTP 服务覆盖“模型请求工具—执行—再次请求”的完整路径。
- 保留阶段 01 的一次性 CLI、配置优先级、退出码、超时和错误脱敏规则。

### 不包含

- 多轮 REPL、会话保存与恢复、跨进程历史。
- 流式响应、SSE、并发工具执行或工具结果增量输出。
- 文件写入、编辑、删除、重命名、目录遍历或命令执行。
- MCP、Skill、插件系统、多 Agent、规划器和上下文压缩。
- 用户交互式审批；本阶段的 `read_file` 是固定的只读工具。
- 自动重试、模型切换或服务端会话持久化。

## 验收场景

### 成功路径：模型读取文件并回答

**给定**：工作区内存在 UTF-8 文本文件 `README.md`，OpenCode Go 可用。

**当**：用户执行 `yucli --prompt "总结 README.md"`。

**那么**：

- 第一次模型请求带有 `read_file` 工具定义。
- 模型返回一个或多个合法的 `read_file` 调用，每个调用有稳定的 `id`。
- 工具读取 `README.md`，产生对应 `tool` 消息并保留调用 ID。
- 第二次模型请求包含原始 user 消息、assistant 工具调用和工具结果。
- 模型返回非空 assistant 文本，CLI 只向 stdout 输出最终文本并以退出码 `0` 结束。

### 不需要工具的成功路径

**给定**：模型直接返回 assistant 文本。

**那么**：

- AgentLoop 不执行工具，也不发起多余的第二次请求。
- CLI 输出文本并以退出码 `0` 结束。

### 合法工具调用的执行错误

**给定**：模型请求未知工具、路径越界、文件不存在、目标是目录、文件不是有效 UTF-8，或文件超过大小上限；调用结构本身是合法的。

**那么**：

- 工具执行器生成一个 `ok: false` 的工具结果，内容只包含安全、可供模型理解的错误摘要。
- AgentLoop 将该结果发回模型，让模型决定如何继续回答。
- 不把本机绝对路径、栈信息、密钥或完整底层异常写入模型消息或 stderr。
- 如果模型随后给出最终文本，CLI 仍可成功结束；如果模型继续请求工具，则继续受最大轮数约束。

### 工具调用结构错误

**给定**：任一调用缺少 ID、名称，参数不是合法 JSON，参数不是对象，缺少字符串 `path`，或包含额外参数。

**那么**：

- 整条 assistant 响应作为协议错误处理，一个工具调用都不执行。
- CLI 返回退出码 `4`，不产生部分配对的 tool 消息。

### 模型持续请求工具

**给定**：模型在达到最大循环次数前持续返回工具调用。

**那么**：

- AgentLoop 在默认最多 `8` 次模型调用后停止。
- CLI 输出安全的循环上限错误并返回退出码 `4`。
- 不执行第 9 次模型调用，也不丢弃已经执行的工具结果。

### 模型返回不完整或被截断的工具调用

**给定**：assistant 同时没有文本、没有合法工具调用，或工具调用缺少 ID、名称或参数；或者服务端返回 `finish_reason: "length"`。

**那么**：

- 客户端或 AgentLoop 将其视为响应协议错误。
- 任一工具调用结构非法时，整条 assistant 响应都失败，一个工具调用也不执行。
- `finish_reason: "length"` 表示响应可能在工具参数中途被截断；客户端必须直接失败，不执行任何工具调用。
- CLI 返回模型错误退出码 `4`。

### 超时、取消和进程边界

- 每次模型调用继续使用阶段 01 的独立超时和 `AbortSignal` 清理规则。
- 工具读取使用同一个调用级取消信号；取消后不得把读取结果继续追加为成功结果。
- 阶段 02 CLI 仍是单次命令，成功或失败后自动结束。
- 工具结果和消息历史只存在当前进程内，不写入磁盘。

## 调用链与状态归属

```text
bootstrap/cli
  → core/agentLoop
      → contracts/LlmClient
      → contracts/ToolRegistry
          → adapters/filesystem/ReadFileTool
      → contracts/LlmClient
  → stdout / stderr / exit code
```

状态归属如下：

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 消息历史 | `AgentLoop` | 一次 CLI 命令 |
| 当前模型轮次 | `AgentLoop` | 一次循环迭代 |
| 工具定义与注册表 | `bootstrap` 创建，`AgentLoop` 只读使用 | 一次 CLI 命令 |
| 工作区根目录 | `bootstrap` 解析并传给工具 | 一次 CLI 命令 |
| 文件内容 | `ReadFileTool` 临时读取 | 单次工具调用 |
| OpenCode 路由 UUID | `OpenCodeGoClient` 每次模型调用生成 | 单次 HTTP 请求 |

`AgentLoop` 是 core 层的流程拥有者；它不读取环境变量、不调用 `node:fs`，也不认识 OpenCode Go 的 `choices` 或 `tool_calls` 外部字段。`ReadFileTool` 只负责文件边界和读取，`bootstrap` 负责组装具体实现。

## 数据结构与接口

阶段 02 需要扩展阶段 01 的消息和模型响应契约。扩展应先同步到 [LlmClient 契约](../contracts/llm-client.md) 和 [工具执行契约](../contracts/tool-execution.md)，再进入代码实现。

推荐的内部结构如下：

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

interface AgentLoopOptions {
  maxModelCalls: number;
  maxToolCallsPerResponse: number;
}

interface AgentLoopResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  // 阶段 02 只有 final_text；后续阶段可以扩展成功停止原因。
  stopKind: "final_text";
}
```

`AgentLoopResult` 只在成功得到最终文本时返回。循环上限、工具协议错误、模型请求错误和取消都通过稳定错误抛出；阶段 02 的循环与协议失败抛 `AgentLoopError`，不会同时返回部分 result。

模型消息需要表达三种新增状态：

```text
assistant：文本、tool_calls 或两者之一
tool：tool_call_id、工具结果文本；内部 `ToolResult` 另行保留工具名
```

推荐规则：

- 一次 assistant 响应可以包含多个工具调用；阶段 02 顺序执行，按模型返回顺序追加结果。
- 工具参数保留原始 JSON 文本，执行器再解析并校验，避免把未经验证的对象直接当成安全输入。
- `ToolResult.content` 始终是可传给模型的文本；成功时是文件内容，失败时是安全错误摘要。
- 工具调用 ID 必须非空且在同一轮中唯一；结果必须使用对应的 `tool_call_id`。
- 任一调用缺少 ID、名称，参数不是合法 JSON，或参数不是恰好包含字符串 `path` 的对象时，整条响应协议错误，一个调用都不执行。
- 名称非空但未注册、路径越界或文件读取失败属于工具执行错误，生成 `ok: false` 的工具结果；它不属于结构性协议错误。
- `read_file` 的参数只有 `{ "path": string }`，不接受 `encoding`、`offset` 或任意额外控制字段。
- `LlmRequest.tools` 是可选字段；工具列表为空时请求体必须省略 `tools`，保证阶段 01 请求格式不变。
- assistant 响应必须包含非空白文本或至少一个合法工具调用；两者都没有时是 `ResponseError`。
- `finish_reason` 保留在内部响应中；值为 `"length"` 时直接产生 `ResponseError`，不执行工具。

## `read_file` 安全边界

推荐默认值：

```text
工作区根目录：启动时的当前工作目录
输入路径：相对路径
最大文件大小：64 KiB（按 UTF-8 字节计算）
编码：UTF-8
空文件：允许，工具成功结果的 `content` 为空字符串
```

执行器必须：

1. 拒绝空白路径、绝对路径和包含 `..` 越界的路径。
2. 先使用 `stat` 检查文件类型和字节大小；`65536` 字节允许，`65537` 字节拒绝。
3. 将路径解析到工作区根目录下，并对真实路径按路径段比较，检查符号链接不能逃出工作区，避免 `/work` 与 `/workspace` 的前缀碰撞。
4. 使用 `Buffer` 读取后通过 `new TextDecoder("utf-8", { fatal: true })` 解码；无效 UTF-8 必须失败，不能静默替换字符。
5. 拒绝目录、特殊文件、超出 64 KiB 的文件和无效 UTF-8 内容。
6. 成功时返回文件原文，不修改内容、不截断、不写入文件。
7. 失败时返回稳定的工具错误分类和适合模型阅读的摘要。

这样先提供一个可理解的文件边界；后续阶段如果需要读取工作区外文件、二进制文件或大文件，应另行设计权限和分页契约。

## 设计选择

### 循环上限

推荐每次 CLI 命令最多进行 `8` 次模型调用，包含第一次请求。这个上限足够覆盖“请求工具 → 返回结果 → 生成回答”的学习场景，也能防止错误模型无限循环。实现时允许通过 core 的测试选项传入较小上限，但阶段 02 不把它暴露成 CLI 参数。

第 8 次响应如果仍然包含工具调用，AgentLoop 抛出 `AgentLoopError("loop_limit")`，不执行这一批工具，也不发起第 9 次模型调用。这样不会产生没有机会被模型消费的孤立 tool message。

### 工具执行顺序

推荐顺序执行同一 assistant 响应中的多个调用。这样日志、消息顺序和文件访问更容易解释；阶段 02 不追求并发，避免引入取消、资源和结果排序问题。

### 工具错误处理

推荐把可恢复的工具错误作为 `ok: false` 的 tool message 交给模型，而不是立即终止进程。模型仍然可以解释“文件不存在”或改用已有信息。循环协议错误、模型请求错误和取消则直接结束本次命令。

单个 assistant 响应最多允许 `4` 个工具调用；超过这个数量视为本阶段不支持的工具批次，抛出 `AgentLoopError("protocol_error")`，不执行该批次。这样在单文件 64 KiB 上限下，也把一轮工具结果控制在约 256 KiB 以内。

### AgentLoop 错误

`AgentLoopError` 使用稳定的 `code`：

```text
loop_limit      # 已达到最大模型调用次数
protocol_error  # 工具批次或模型循环协议不合法
```

两者都由 CLI 映射为退出码 `4`。可恢复的文件错误仍然是 tool message，不升级为 `AgentLoopError`。

### finish_reason 一致性

阶段 02 只把 `finish_reason: "length"` 定义为必须失败的截断信号。其他值与 `tool_calls` 的组合暂不增加额外一致性拒绝规则；如果服务端返回工具调用但使用未知 `finish_reason`，只要工具调用结构完整，按工具调用处理，并在真实联调记录实际行为。

这是阶段 02 的保守选择。阶段 03 如果引入可恢复的 `limited` 或部分输出语义，应重新评估是否仍对 `length` 全量失败，并同步更新响应契约和测试。

### 工具路径范围

推荐只允许当前工作区内的相对文本文件，并限制为 64 KiB。备选方案是允许用户显式指定根目录或直接读取绝对路径，但这会改变权限边界，应留到后续阶段并单独设计。

## 任务清单

- [x] 将阶段状态从 `proposed` 改为 `designed`，确认范围和推荐选择。
- [ ] 扩展 `Message`、`LlmRequest`、`LlmResponse`，支持 assistant tool calls、tool messages、可选 `tools` 和 `finishReason`。
- [ ] 扩展 OpenCode Go adapter 的请求体和响应解析，覆盖工具定义、调用 ID 和参数 JSON。
- [ ] 新增 `Tool`、`ToolDefinition`、`ToolCall`、`ToolResult`、`ToolRegistry` 和 `AgentLoopError` 契约。
- [ ] 实现 `ReadFileTool`，先 `stat` 再读取，使用 fatal UTF-8 解码，并完成路径段、符号链接、大小、目录校验。
- [ ] 实现 `AgentLoop`，覆盖最终文本、工具调用、工具错误、截断响应、全有或全无校验、批次上限和最大轮数。
- [ ] 在 bootstrap 中注册 `read_file` 并把工作区根目录传入工具。
- [ ] 更新 CLI，使阶段 01 的单次无工具路径继续兼容。
- [ ] 更新 CLI 契约，记录 `AgentLoopError` 的退出码 4。
- [ ] 增加本地 HTTP、工具执行、循环和 CLI 子进程测试。
- [ ] 更新 `LlmClient`、OpenCode Go HTTP、工具和 CLI 契约，以及相关 ADR。

## 验证计划

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev --help
pnpm dev --prompt "请总结 README.md"
```

自动测试至少覆盖：

- 模型直接返回文本时只调用一次模型。
- 合法 `read_file` 调用会生成正确的 tool message，并在下一轮传回模型。
- 多个工具调用按顺序执行并保持调用 ID 对应关系。
- 未知工具、路径越界、符号链接越界、目录和超大文件返回工具错误。
- 非法 JSON、缺少 `path`、额外参数或错误参数类型触发整体协议错误，任何工具都不执行。
- 工具错误可以被模型看到；循环达到上限时不会产生额外模型请求。
- 第 8 次响应包含工具调用时，不执行这批工具，且不会发起第 9 次模型请求。
- assistant 只有工具调用时被接受；只有空文本且无工具调用时拒绝。
- `finish_reason: "length"` 时不执行工具。
- 工具批次中任一调用结构非法时，整个批次不执行。
- 空工具列表时请求体省略 `tools`；有工具时请求体包含工具定义。
- 请求体包含工具定义，响应中的 `tool_calls` 和 `finish_reason` 能转换为内部结构。
- 发往模型的 tool message 省略 `name` 字段，只保留 `role`、`tool_call_id` 和 `content`。
- AgentLoop 成功返回 `AgentLoopResult`；循环或协议失败抛出 `AgentLoopError`。
- `read_file` 对 65536/65537 字节、空文件和非法 UTF-8 具有明确结果。
- AgentLoop 返回包含 `finalText`、`modelCalls`、`toolResults` 和 `stopKind` 的结果对象。
- 阶段 01 的参数错误、配置错误、模型错误、stdout/stderr 和退出码不回归。

真实联调需要验证一次“模型请求 `read_file`、工具往返后根据文件内容回答”的成功路径，并确认多次 HTTP 请求各自携带新的 `x-opencode-session` 仍可完成同一命令。不把真实服务的具体回答文本写入测试断言。

## 实际结果

### 已完成

阶段 02 尚未实现。本文件只记录设计和验收要求。

### 验证命令与结果

尚未运行阶段 02 的实现验证。阶段 01 的既有验证结果见[阶段 01 规格](phase-01-single-model.md)。

### 遗留问题与下一步

- 阶段 02 尚未实现；本文件中的规则需要在进入实现前保持与契约和测试一致。
- 需要在真实联调中确认多轮请求下 `x-opencode-session` 每请求独立 UUID 的可行性，并回写 ADR-002/003。
- 阶段 02 完成后，才能决定阶段 03 是否引入 REPL、流式输出或更长的消息历史。
