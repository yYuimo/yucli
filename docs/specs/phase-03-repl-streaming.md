# 阶段 03：持续对话与流式输出

状态：`proposed`

阶段 03 建立在阶段 02 的单次工具循环之上，把一次命令扩展为同一进程内的 REPL，并把 OpenCode Go 的非流式请求扩展为 SSE 流式请求。历史只存在内存；会话持久化、恢复和上下文压缩留到阶段 04 及以后。

本文件已经为实现前的高影响选择给出推荐方案。实现开始前应将阶段状态改为 `designed`，同步接受相关契约和 ADR；本阶段只写设计，不修改实现代码。

## 目标场景

用户启动：

```bash
yucli
```

随后可以连续提问：

```text
yucli> 什么是 Promise？
Promise 是……（模型文本分片按顺序显示）

yucli> 读取 README.md 并总结
……（流式文本或工具调用过程）

yucli> /exit
```

后一个问题携带前面已经完成的消息历史。流式模型响应中的文本分片立即按顺序写到 stdout；工具调用分片只在内存中拼装，完整校验并执行后，再把工具结果发起下一轮模型请求。

`--prompt <text>` 继续保留为单次模式：执行一轮流式问答后退出。无 `--prompt` 时进入 REPL。

## 范围

### 包含

- 同一进程内的 REPL、多轮历史和 `/exit`、`/quit`、`/clear`、`/help` 内置命令。
- OpenCode Go `stream: true` 请求和 OpenAI 兼容 SSE 解析。
- provider-neutral 的流式事件模型：文本 delta、工具调用 delta、message end、usage。
- 按工具调用 index/ID 保存独立拼装状态，支持交错调用和参数跨 chunk 拼接。
- 流结束后的工具调用完整校验，沿用阶段 02 的全有或全无、每批最多 4 个、每次命令最多 8 次模型调用。
- 流式文本的朴素 stdout 渲染，以及最终消息历史的提交边界。
- REPL 中当前轮次的取消、超时、连接中断和恢复输入提示。
- 本地 mock SSE 测试、CLI 子进程测试和一次真实多轮流式工具联调。

### 不包含

- 会话持久化、跨进程恢复和崩溃恢复（阶段 04）。
- 文件写入、命令执行、审批、MCP、Skill、多 Agent。
- 上下文压缩、token 预算和多 provider 接入。
- 流式 reasoning/thinking 的独立渲染；未知 provider 扩展字段只允许被忽略。
- 并发工具执行、重试、断线重连和 renderer 插件体系。

## 验收场景

### REPL 多轮历史

**给定**：用户启动 `yucli`，OpenCode Go 可用。

**当**：用户连续输入两个普通问题。

**那么**：

- 每个问题都生成一次 user 消息。
- 第二轮请求包含第一轮已经完成的 user/assistant 消息。
- 每轮完成后才把 assistant 消息加入历史；取消或失败的半截 assistant 响应不进入历史。
- `/clear` 丢弃内存历史但不影响当前配置；下一轮只包含新的 user 消息。
- `/exit`、`/quit` 和输入 EOF 以退出码 `0` 结束。

### 流式文本输出

**给定**：服务端返回多个 SSE 文本 delta，事件可能跨 HTTP chunk。

**那么**：

- 事件按网络流中的逻辑顺序解析，文本 delta 按收到顺序写入 stdout。
- 多字节 UTF-8 被拆在不同 chunk 时不能产生替换字符或乱码。
- 收到最终 message end 后输出一个换行，并提交完整 assistant 文本到历史。
- 不把原始 SSE、HTTP 调试信息或完整请求体写入 stdout。

### 流式工具往返

**给定**：模型通过多个 SSE delta 请求 `read_file`，工具调用参数跨 chunk，多个调用可能交错。

**那么**：

- 每个工具调用按 index/ID 单独拼装，不能使用一个全局参数字符串。
- 在合法 message end 之前不执行工具；`[DONE]` 只确认传输结束，不能替代 message end。
- 所有调用的 ID、名称、参数 JSON 和 `read_file` 参数结构都通过校验后，才按顺序执行整批工具。
- 工具结果加入历史后发起下一次流式模型请求。
- 最终文本继续按 delta 输出，并在完成后提交最终 assistant 消息。

### 截断、缺帧和连接中断

**给定**：`finish_reason: "length"`、缺少 message end、SSE JSON 非法或响应流在收尾前断开。

**那么**：

- 不执行任何未完成或已看似完整的工具调用。
- 已经写到 stdout 的文本保留为用户可见的部分输出；随后写入安全错误状态到 stderr。
- 单次 `--prompt` 以退出码 `4` 结束；REPL 放弃当前轮并回到下一次输入提示。
- 不把半截 assistant/tool 消息写入内存历史。

### 取消与超时

- REPL 正在等待模型流时收到 Ctrl+C：取消当前轮，清理响应流和定时器，回到输入提示，不退出进程。
- 单次 `--prompt` 正在请求时收到 Ctrl+C：取消当前轮并以退出码 `4` 结束，延续阶段 01/02 的模型错误边界。
- REPL 等待用户输入时收到 Ctrl+C：退出进程，退出码 `130`。
- `YUCLI_REQUEST_TIMEOUT_MS` 继续表示一次模型请求的总期限，覆盖连接、SSE 读取和收尾；超时后按模型错误处理。
- 工具读取沿用阶段 02 的取消信号；取消时不提交半完成工具批次。

## 调用链与状态归属

```text
bootstrap/cli
  → REPL 输入循环（读取 prompt 或内置命令）
      → core/runTurnStream
          → contracts/LlmClient.stream
              → adapters/opencode-go SSE parser
          → core/streamAssembler
          → core/toolRegistry → adapters/filesystem/ReadFileTool
      → stdout 朴素渲染 / stderr 状态
```

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 已完成消息历史 | REPL 外层 | 一次进程，`/clear` 时清空 |
| 当前 turn 的临时 assistant/tool 拼装 | `runTurnStream` 和 assembler | 当前模型响应，成功结束后提交 |
| 文本 delta 渲染 | bootstrap 的简单输出函数 | 当前流；不反向修改历史 |
| SSE reader、decoder、定时器 | OpenCode adapter | 单次 `stream()` 调用，finally 清理 |
| 工具调用预算 | AgentLoop/runTurn | 当前进程命令，沿用阶段 02 上限 |

REPL 拥有跨轮历史；core 每次接收历史快照和一个 prompt，不把历史放进全局变量。推荐最多保留最近 `20` 个已完成 user turn；超出时丢弃最旧的完整 turn，不截断一个 assistant/tool 组。这个朴素上限只防止无限增长，不做 token 预算或语义压缩。

## 数据结构与接口

### LlmClient 流式扩展

阶段 03 不重构 `complete()`，新增并行的 `stream()`：

```ts
interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  stream(
    request: LlmRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmStreamEvent>;
}

type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "message_end";
      finishReason?: string;
      usage?: LlmUsage;
    }
  | { type: "usage"; usage: LlmUsage };
```

推荐让网络、SSE、协议和取消失败通过 async generator 抛出稳定错误，而不是伪装成正常事件。`message_end` 是逻辑消息收尾；`[DONE]` 是传输层结束标记，adapter 不能只收到 `[DONE]` 就假定消息合法。

阶段 03 扩展状态为 `draft`，`complete()` 和阶段 01/02 的无工具请求保持兼容。`stream()` 的事件模型只暴露 provider-neutral 字段，不把 OpenCode 的原始 chunk 交给 core。

### 流式工具调用状态

```ts
interface ToolCallAssembly {
  index: number;
  id: string;
  name: string;
  argumentsJson: string;
}

interface StreamTurnResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  stopKind: "final_text";
}
```

assembler 使用 `Map<number, ToolCallAssembly>` 保存每个 index 的独立状态：

1. 收到带 `id`/`name` 的 delta 时创建或补全对应状态。
2. 收到 `argumentsDelta` 时追加到该 index 的 JSON 字符串。
3. 收到 message end 后按 index 排序，检查 ID、名称、JSON、参数 schema 和批次上限。
4. 全批校验通过后转换为阶段 02 的 `ToolCall[]`；任一项失败则整个批次失败。

不能采用 `paicli-ts` 中单个 `currentToolInput` 变量的简单累积方式，因为交错的多个工具调用会把不同 index 的参数混在一起。

### REPL 命令与结果

```text
/exit  /quit   结束进程，退出码 0
/clear         清空内存历史
/help          输出命令帮助
空行           忽略，不发模型请求
EOF             结束进程，退出码 0
```

普通输入交给 `runTurnStream`。成功的 `StreamTurnResult` 才能更新历史；失败、取消、超时和协议错误只更新屏幕状态，不把半截消息写入历史。

## 设计选择

### 1. `stream()` 而不是重构 `complete()`

推荐增加 `LlmClient.stream()`，保留 `complete()`。这样阶段 01/02 的稳定接口和测试继续有效，阶段 03 只新增流式能力；未来如果需要，`complete()` 可以在 adapter 内部复用非流式请求，但不改变已有语义。备选是把 `complete()` 改成同时支持流式和非流式的联合返回，这会把调用方、错误和测试全部复杂化。

### 2. SSE 和工具拼装的收尾

推荐由 adapter 负责字节到 `LlmStreamEvent` 的 SSE 转换，由 core assembler 负责按 index 拼装。`finish_reason: "length"`、缺少 message end、`[DONE]` 前连接中断、非法 JSON、缺 ID/名称/参数和批次超限都直接失败，不执行工具。流式文本可以已经显示，但不进入历史。

### 3. REPL 历史和上下文上限

推荐 REPL 外层持有历史，core 每轮接收历史快照；最多保留最近 20 个完整 user turn，按完整 turn 丢弃旧历史。备选是暂时不设上限，但连续输入会无限增加请求体，阶段 04 再处理会让阶段 03 的 REPL 很快遇到上下文问题。

### 4. Ctrl+C 语义

推荐区分“正在请求”和“等待输入”：请求中取消当前轮并在 REPL 继续，输入等待中退出并返回 130。单次 `--prompt` 取消返回 4，以延续既有模型错误退出码。半截文本保留在屏幕上，半截消息不进入历史。

### 5. 渲染策略

推荐先直接 `process.stdout.write(textDelta)`，由 bootstrap 提供一个很小的换行和状态收尾函数，不引入 renderer interface、事件总线或 TUI。阶段 03 只需验证分片顺序和输出边界；等出现 Markdown、thinking、并行任务或终端重绘需求再抽象。

### 6. OpenAI 兼容基类

推荐阶段 03 暂不抽出 `adapters/openai-compatible/OpenAICompatibleClient`。当前只有 OpenCode Go 一个提供方，抽基类会同时改变构造、错误、超时和测试边界；先在 `OpenCodeGoClient` 内增加 SSE 解析和消息映射。等第二个真实提供方出现，再以重复协议行为为依据抽取基类，并新增 ADR。

### 7. 测试策略

继续使用真实 adapter + 本地 mock HTTP/SSE 服务，不新增假模型客户端。测试服务必须能按指定字节块和时间间隔写 SSE，以覆盖协议边界；CLI 用子进程验证 stdout、stderr、退出码和 REPL 输入。

## 任务清单

- [ ] 将阶段状态改为 `designed`，确认上述七项决策。
- [ ] 新增流式事件和 `LlmClient.stream()` 契约，标记阶段 03 扩展为 draft。
- [ ] 新增 SSE 解析契约，定义 UTF-8、事件边界、心跳、JSON 和 `[DONE]` 行为。
- [ ] 实现 OpenCode Go `stream: true` 请求、SSE parser 和资源清理。
- [ ] 实现按 index/ID 的工具调用 assembler，支持交错 delta 和全批校验。
- [ ] 将阶段 02 的工具循环提取为可被流式 turn 使用的 core 流程，保持 4/8 上限。
- [ ] 实现 REPL 输入循环、历史持有、20 turn 上限和 `/exit`、`/quit`、`/clear`、`/help`。
- [ ] 实现朴素 stdout delta 渲染、换行收尾和错误状态输出。
- [ ] 实现 active-stream Ctrl+C、idle-input Ctrl+C、超时和连接中断收尾。
- [ ] 更新 `llm-client`、OpenCode Go、tool、CLI 契约和架构文档。
- [ ] 新增 ADR-004（流式事件与 REPL 生命周期）和 ADR-005（暂不抽 OpenAI 兼容基类）。
- [ ] 增加本地 mock SSE、assembler、取消/超时和 REPL 子进程测试。
- [ ] 真实联调一次连续两轮文本，再联调一次流式 `read_file` 工具往返。

## 验证计划

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev --help
pnpm dev
pnpm dev --prompt "请读取 README.md 并总结"
```

自动测试至少覆盖：

- 文本 delta 顺序、跨 HTTP chunk 的 SSE 事件和跨 chunk 的半截 UTF-8。
- `\n\n`/CRLF 事件边界、注释心跳、多行 data、JSON 错误和 `[DONE]`。
- 缺少 message end、`finish_reason: "length"`、连接中断和响应体读取超时。
- 两个或多个工具调用按 index 交错，参数独立拼装，不发生单变量串线。
- 半截参数、缺 ID/名称、重复 ID、批次超过 4 个和任一非法调用时整批不执行。
- 流式工具成功后下一轮历史包含完整 assistant/tool 消息，最终文本按 delta 输出。
- active-stream Ctrl+C 取消当前轮并回到 REPL；idle-input Ctrl+C 退出 130；单次模式取消退出 4。
- `/clear`、`/help`、`/exit`、`/quit`、EOF、空行和 20 turn 历史裁剪。
- 阶段 01/02 的 `--prompt`、无工具 complete、退出码和 `tools` 省略行为不回归。
- CLI 子进程 stdout 只含文本和提示，stderr 只含安全状态，不包含密钥、原始 SSE 或参数 JSON。

真实联调不把模型回答文本写进断言，只记录请求次数、事件类型、工具 ID 配对、finish reason、退出状态和是否出现错误。

## 实际结果

### 已完成

阶段 03 尚未实现。本文件只记录设计和验收要求。

### 验证命令与结果

尚未运行阶段 03 实现验证。阶段 01/02 的验证记录保留在各自规格中。

### 遗留问题与下一步

- 需要确认七项推荐设计，尤其是 `stream()` 事件模型、Ctrl+C 语义、20 turn 上限和是否暂不抽基类。
- 需要实现前同步更新流式、REPL、LlmClient 和 OpenCode Go 契约。
- 阶段 03 完成后，阶段 04 再设计会话持久化、恢复和中断轮次修复。
