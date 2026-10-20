# 阶段 03：持续对话与流式输出

状态：`implementing`

设计评审：2026-10-19，用户确认七项推荐选择；主体实现已完成；2026-10-20 重开 usage-only 兼容修复并完成验证，按本次要求保持 implementing，等待修复审查。

阶段 03 建立在阶段 02 的单次工具循环之上，把一次命令扩展为同一进程内的 REPL，并把 OpenCode Go 的非流式请求扩展为 SSE 流式请求。历史只存在内存；会话持久化、恢复和上下文压缩留到阶段 04 及以后。

本文件已根据评审确认七项高影响选择，并接受相关 ADR；契约扩展在开发期间保持 `draft`，现已随实现验证转为 `accepted`。实现遵循本文任务清单与验收边界。

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
- 流结束后的工具调用完整校验，沿用阶段 02 的全有或全无、每批最多 4 个、每个 turn 最多 8 次模型调用。
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
- 在合法 message end 之前不执行工具；`[DONE]` 只确认可选的传输结束，不能替代 message end。
- 所有调用的 ID、名称、参数 JSON 和 `read_file` 参数结构都通过校验后，才按顺序执行整批工具。
- 工具结果加入历史后发起下一次流式模型请求。
- 最终文本继续按 delta 输出，并在完成后提交最终 assistant 消息。

### 截断、缺帧和连接中断

**给定**：`finish_reason: "length"`、缺少 message end、SSE JSON 非法或响应流在 message end 前断开。

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
| 工具调用预算 | AgentLoop/runTurn | 当前 turn，沿用阶段 02 上限 |

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
    }
  | { type: "usage"; usage: LlmUsage };
```

推荐让网络、SSE、协议和取消失败通过 async generator 抛出稳定错误，而不是伪装成正常事件。`message_end` 是逻辑消息收尾并决定业务成功；`[DONE]` 是可选的传输层结束标记，adapter 不能只收到 `[DONE]` 就假定消息合法。

阶段 03 扩展已实现并验证，状态为 `accepted`；`complete()` 和阶段 01/02 的无工具请求保持兼容。`--prompt` 在阶段 03 改走 `stream()`；`complete()` 和阶段 02 的非流式 `agentLoop` 保留为兼容/测试路径，不再是阶段 03 CLI 的生产调用者。阶段 01/02 的 wire 测试继续直接覆盖 `complete()` 的 `stream:false` 请求；阶段 03 另加 `stream:true` SSE 测试，CLI 的 stdout/stderr/退出码兼容不等于 wire 字段不变。`stream()` 的事件模型只暴露 provider-neutral 字段，不把 OpenCode 的原始 chunk 交给 core。

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
  appendedMessages: readonly Message[];
  stopKind: "final_text";
}
```

`StreamTurnResult` 的规范定义见 [REPL 契约](../contracts/repl.md)；`appendedMessages` 是 REPL 提交历史所需的完整 user/assistant/tool 消息组。

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

推荐由 adapter 负责字节到 `LlmStreamEvent` 的 SSE 转换，由 core assembler 负责按 index 拼装。`finish_reason: "length"`、message end 前断开、非法 JSON、缺 ID/名称/参数和批次超限都直接失败，不执行工具。message end 到达且没有工具调用时，最终文本仍必须是非空白；空文本加无工具调用是 `ResponseError`。message end 成功后即使服务随后没有发送 `[DONE]`，也按成功处理。流式文本可以已经显示，但不进入历史。

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

- [x] 将阶段状态改为 `designed`，确认上述七项决策。
- [x] 按已接受的流式事件和 `LlmClient.stream()` 契约实现代码。
- [x] 新增 SSE 解析契约，定义 UTF-8、事件边界、心跳、JSON 和 `[DONE]` 行为。
- [x] 实现 OpenCode Go `stream: true` 请求、SSE parser 和资源清理。
- [x] 实现按 index/ID 的工具调用 assembler，支持交错 delta 和全批校验。
- [x] 将阶段 02 的工具循环提取为可被流式 turn 使用的 core 流程，保持 4/8 上限。
- [x] 实现 REPL 输入循环、历史持有、20 turn 上限和 `/exit`、`/quit`、`/clear`、`/help`。
- [x] 实现朴素 stdout delta 渲染、换行收尾和错误状态输出。
- [x] 实现 active-stream Ctrl+C、idle-input Ctrl+C、超时和连接中断收尾。
- [x] 更新 `llm-client`、OpenCode Go、tool、CLI 契约和架构文档。
- [x] 新增 ADR-004（流式事件与 REPL 生命周期）和 ADR-005（暂不抽 OpenAI 兼容基类）。
- [x] 增加本地 mock SSE、assembler、取消/超时和 REPL 子进程测试。
- [x] 真实联调一次连续两轮文本，再联调一次流式 `read_file` 工具往返。

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
- usage 始终作为独立 `usage` 事件；`message_end` 只携带 `finishReason`，重复等值 usage 不重复发出。
- 缺少 message end、`finish_reason: "length"`、连接中断和响应体读取超时。
- message end 到达后流直接关闭也算成功；只有 `[DONE]` 而没有 message end 算协议错误。
- message end 无工具调用时，空白最终文本触发 `ResponseError`。
- 两个或多个工具调用按 index 交错，参数独立拼装，不发生单变量串线。
- 半截参数、缺 ID/名称、重复 ID、批次超过 4 个和任一非法调用时整批不执行。
- 流式工具成功后下一轮历史包含完整 assistant/tool 消息，最终文本按 delta 输出。
- active-stream Ctrl+C 取消当前轮并回到 REPL；idle-input Ctrl+C 退出 130；单次模式取消退出 4。
- `/clear`、`/help`、`/exit`、`/quit`、EOF、空行和 20 turn 历史裁剪。
- 阶段 01/02 的 `--prompt`、无工具 complete、退出码和 `tools` 省略行为不回归。
- 阶段 01/02 的 `complete()` wire 测试继续断言 `stream:false`；阶段 03 的 `--prompt`/REPL 另断言 `stream:true`。
- CLI 子进程 stdout 只含文本和提示，stderr 只含安全状态，不包含密钥、原始 SSE 或参数 JSON。

真实联调不把模型回答文本写进断言，只记录请求次数、事件类型、工具 ID 配对、finish reason、退出状态和是否出现错误。

## 实际结果

### 已完成

- 先以独立提交对齐 ADR-004 的 message end 边界和本规格的契约状态措辞，全文扫描 accepted、[DONE] 前、收尾前、message_end.usage，未发现同类遗漏；未改变已确认设计。
- 新增 provider-neutral 的 LlmStreamEvent、LlmClient.stream 和 StreamTurnResult。complete、runPrompt、非流式 agentLoop 保留；兼容路径只依赖 Pick<LlmClient, "complete">。
- OpenCodeGoClient.stream 每请求使用独立 UUID、控制器、总超时、reader 与 decoder；SseParser 处理 fatal UTF-8、跨字节块、LF/CRLF、心跳、多行 data，streamChunk 映射业务字段并忽略 reasoning。message end 才是逻辑成功，[DONE] 可选，缺 message end 仍失败。
- StreamAssembler 使用 Map<number, ToolCallAssembly> 隔离交错调用，按 index 排序后复用整批结构/参数校验；任一调用非法、length、缺帧或超批次时一个工具也不执行。两种循环共用 loopLimits 与 executeToolBatch，8 次模型/每批 4 项、顺序执行，最后一轮若仍有工具则不执行。
- CLI 两种模式均走 stream；REPL 保存最近 20 个成功完整 turn，成功才提交 appendedMessages，/clear 整体清空，支持 /help、/exit、/quit、空行和 EOF。文本即时显示，失败后补足换行，部分输出不提交历史。
- 取消贯穿模型和工具：REPL 活跃时取消当前 turn 并恢复输入，闲置退出 130，单次取消退出 4。reader、定时器、监听器与 readline 在相应边界清理。
- README、architecture、客户端/流式/REPL/工具/CLI 契约与 ADR-002 已同步；新增与修改的 src 函数、接口及字段均提供中文说明和逻辑空行。
- 未新增运行依赖，未加入持久化、文件写入、审批、MCP、多 provider、renderer 抽象或 token 预算。

### 验证命令与结果

工具链为项目固定的 Node.js 24.14.0、pnpm 10.33.2；本机通过下列包装运行 pnpm（未使用全局旧版本）：

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm dev --help'
```

- typecheck、lint、test、build 全部通过；9 个测试文件、205 个用例。
- CLI --help 用项目工具链运行成功，显示无 prompt 的 REPL 入口、内置命令和三种 Ctrl+C 语义。
- CLI --prompt 与 REPL 子进程测试同时覆盖源码/构建产物；complete wire 测试继续断言 stream:false，阶段 03 CLI/SSE 断言 stream:true；空/缺 tools 省略。
- mock SSE 支持指定原始字节块和写入间隔；覆盖单字节跨 UTF-8/CRLF/事件边界、LF、多行 data、心跳、reasoning 忽略、非法 JSON/字段、[DONE]、缺帧、length、连接中断、读取超时、取消和 generator 提前关闭清理。
- 流式 turn 覆盖交错 index、ID/名称晚到、身份变更、缺 ID/名称/参数、重复 ID、坏 JSON/参数、4 项成功/5 项拒绝、空白最终文本、8 次上限和第 8 次文本成功。整批拒绝时验证工具执行次数为零。
- REPL 子进程覆盖两轮历史、完整工具组裁剪、20 turn 上限、失败/超时/取消不提交、下一轮可用、三种 SIGINT、命令、空行和管道连续输入/EOF。
- 另用本地 SSE 服务及 Python 标准库 PTY，向构建产物终端实际发送 Ctrl+C 字节（0x03）：活跃时取消、下一轮成功、闲置退出 130，全部通过。临时脚本无新依赖，不访问真实凭证。

### 真实联调（2026-10-19）

使用现有 .env、项目工具链和构建产物，模型 deepseek-v4-flash。临时观测器仅提取请求计数、角色顺序、事件计数、ID 配对、finish reason、路由 UUID 独立性及字段是否出现，不保存凭证、文件正文或模型回答，也未把模型文本写入断言。

| 场景 | 请求与历史 | 流事件/协议结果 | CLI 结果 |
| --- | --- | --- | --- |
| REPL 连续两轮纯文本 | 2 次 HTTP 200；角色依次 user，user/assistant/user；2 个独立 UUID | text_delta 74、message_end 2、usage 2；finish reason 均 stop；两次均出现 [DONE]、usage 对象和 reasoning 字段 | /exit 后 0；回答非空，stderr 为空；约 6.366 秒 |
| --prompt 流式 read_file 往返 | 2 次 HTTP 200；第二次含 user/assistant/tool；1 项调用与 tool 结果 ID 配对；2 个独立 UUID | tool_call_delta 11、text_delta 105、message_end 2、usage 2；finish reason 为 tool_calls、stop；两次均出现 [DONE]、usage 对象和 reasoning 字段 | 0；回答非空，stderr 为空；约 6.511 秒 |

成功的四次请求 UUID 互不相同。reasoning 字段只做存在性观测，未渲染或存入历史。上述成功结果支持当前账号/模型的逐请求 UUID 策略，已回写 ADR-002。

联调过程中也记录了失败与修复：

1. 首轮文本两次、工具一次，共 3 次 HTTP 200，早期 SSE 帧的 usage:null 被初版流式映射误判为非法对象，均未完成 turn、未执行工具。现将流式 null 视为尚未提供统计，只有对象用量才发独立事件，并补回归；complete 对 null usage 的既有拒绝行为保持且有测试。契约同步明确了此映射。
2. 修复后的首次工具尝试在 tool_calls 的 message end 后抛 ResponseError，退出 4，工具执行零次；当时错误归因为“不合规 choice/delta 收尾帧、重跑未复现”。2026-10-20 用户提供的 2026-10-19 抓包和稳定 CLI 复现已纠正该结论：这是合法的 `choices:[] + usage` 统计帧被客户端误拒，不是服务端协议不合规。后续修复与验证记录见下节。
3. 2026-10-19 初次阶段验证共发起 8 次 HTTP 请求（含上述失败尝试）；成功场景见表格，不能将 REPL 在 /exit 时返回 0 等同于此前每个 turn 都成功。

### usage-only 兼容修复（2026-10-20，修复验证完成）

- 证据来源：用户提供的 2026-10-19 抓包与实际 CLI 稳定复现。服务在 finish 帧后、[DONE] 前发送 `data: {"choices":[],"usage":{...}}`；usage 与 finish 帧逐字段相同，属于重复统计。
- 缺陷原因：parseStreamChunk 无条件读取 choices[0].delta，统计帧尚未进入 usage 校验就被拒绝。可见表现是答案已输出，随后 stderr 报“流式响应需要 choice 和 delta 对象。”、单次退出 4；REPL 的该 turn 同样失败，不提交历史。
- 已确认修复边界：非空 choices 仍严格校验 delta/工具/finish reason；空 choices 仅在带合法 usage 对象时作为统计帧，空 choices 无 usage 仍拒绝。统计帧只发 usage，不产生 message_end；去重继续由每请求 seenUsage 处理，等值一次、不同值分别发出。
- 失败复现（助手本轮实际运行）：修复前新增“usage-only 首次提供统计”“finish 与统计帧等值去重”“两个统计帧不同值”三个 mock SSE 用例，三项均失败，堆栈定位 parseStreamChunk，错误正是“流式响应需要 choice 和 delta 对象。”。使用真实 adapter + 本地 SSE，没有新增假模型客户端。
- 实现：先校验 choices 数组，再按非空消息帧/空数组统计帧分支；提取 parseStreamUsage 复用同一套对象、非负安全整数与字段映射校验。OpenCodeGoClient.seenUsage、message_end/[DONE]/length 校验和 complete() 均未改动；src 补充了分支、数据流和校验边界的中文注释。
- 本地验证（本轮重新执行）：固定 Node.js 24.14.0 / pnpm 10.33.2 下运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`，全部通过；9 个文件、220 个用例。命令包装为 `npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm test && pnpm build'`。
- 回归覆盖：三种成功统计/去重情况均检查事件及完整 turn 成功；空 choices 无 usage、无 choices、非法 usage 对象/计数、非空 choices 的坏 delta 仍拒绝。统计帧不能掩盖缺 message_end、空白最终文本或 length，相关批次工具执行次数为零。原有坏 JSON/tool_calls、UTF-8、取消、超时及 8/4 额度测试全部保留通过。
- CLI/REPL 回归：mock helper 可在 finish 帧携带 usage 并在 [DONE] 前追加等值 usage-only；源码与构建产物的 --prompt、工具往返和 REPL 历史/命令/取消测试均使用该序列通过，stdout 不显示统计帧，也不再丢弃合法 turn。

真实联调使用现有 .env 和构建产物，以临时观测器只采集协议元数据（未保存密钥、文件正文或模型回答，未将模型文本写进断言）：

| 场景 | 请求与停止原因 | usage 与流结束 | CLI 结果 |
| --- | --- | --- | --- |
| --prompt 纯文本 | 1 次 HTTP 200，deepseek-v4-flash，stream:true，finish reason 为 stop | 实际收到 1 个 choices:[] + usage 对象的统计帧；原始 usage 2 份、规范化后等值、内部 usage 事件 1 次；message_end 1、text_delta 17；正常收到 [DONE] | stdout 有回答，stderr 为空，退出 0；约 3.872 秒 |
| --prompt 流式 read_file 往返 | 2 次 HTTP 200，finish reason 依次 tool_calls、stop；第二次请求为 user/assistant/tool，1 项 read_file 调用与结果 ID 配对 | 每次均实际收到 1 个 usage-only 帧、原始 usage 2 份、内部 usage 事件 1 次；message_end 各 1；首请求 tool_call_delta 11，次请求 text_delta 13；两次 [DONE] 均正常 | stdout 有回答，stderr 为空，退出 0；约 6.187 秒 |

本次真实重跑共 3 次请求、3 个不同的 x-opencode-session UUID；共 3 个 usage-only 帧，原始 6 份用量规范化去重后发出 3 个事件。纯文本及工具首请求出现 reasoning 字段，工具最终回答未见该字段；均未渲染 reasoning。真实帧结构与用户给出的证据一致，修复后的成功不是此前“未复现”重试的替代陈述；不同值统计分别发出的行为由确定性 mock SSE 验证。

### 遗留问题与下一步

- 本次修复范围与验证均已完成，无未完成修复项；阶段按本次要求从 verified 回到 implementing，保持此状态等待修复审查。停在 phase/03-repl-streaming，不合并、不推送。
- 原“不合规收尾帧”已确认是客户端误拒合法 usage-only 帧，现已修复；不再将该兼容缺陷归因于服务异常。其他坏 JSON、delta、工具批次、缺 message_end 和 length 的拒绝边界保持。
- 20 turn 只限制数量，未限制 token 或单条响应体积；上下文溢出仍按模型错误 + /clear 处理。持久化、恢复、压缩等留到阶段 04 设计。
