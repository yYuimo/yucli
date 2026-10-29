# yucli 初始架构与开发路线

状态：阶段 01 和阶段 02 已按四层依赖结构实现、验证并完成项目规划审查（`done`）；阶段 03 已验证；阶段 04 规格完成评审并进入 `designed`，持久化实现尚未开始。

## 目标场景

第一条完整用户路径是：

```text
终端输入问题
  → 组装模型请求
  → 模型返回回答，或请求读取一个文件
  → 执行只读文件工具
  → 把工具结果和调用 ID 加回消息历史
  → 模型生成解释
  → 终端输出最终回答
```

阶段 1 先只实现“终端输入问题 → 一次模型回答”。文件工具和循环属于阶段 2，不在第一次工程实现中提前加入。

## 借鉴范围

### Pi

借鉴 Agent Loop 的主线和两个边界：内部可以保留适合 Agent 的消息，调用模型前再转换为提供方消息；文本、工具调用和工具结果通过事件或明确的结果对象向外传递。第一版只保留必要的同步顺序流程，暂不引入完整事件流、steering 和 follow-up 队列。

参考入口：

- `../../references/pi/packages/agent/src/agent-loop.ts`
- `../../references/pi/packages/agent/src/types.ts`
- `../../references/pi/packages/agent/README.md`

### ZCode

借鉴核心接口与外部适配器分工，以及文件工具对实际文件状态的检查思路。第一版不会复制它的多包仓库、权限体系、工作流和复杂会话模型；这些内容只有在对应功能出现时才选读。

参考入口：

- `../../references/zcode/apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
- `../../references/zcode/apps/zcode-cli/packages/adapters/src/storage/session-store/`
- `../../references/zcode/apps/zcode-cli/packages/core/src/tool/`

### DSH

借鉴“会话记录与模型历史可以分开”的思想，以及持久化接口的写入、刷新和恢复边界。会话阶段再决定采用简单快照还是仅追加记录；起步阶段不引入完整事件溯源、事件投影和插件生命周期。

参考入口：

- `../../references/dsh/packages/core/agent-loop/README.zh.md`
- `../../references/dsh/packages/core/session/README.zh.md`
- `../../references/dsh/packages/session/session-persistence/README.zh.md`

## 第一版模块边界

项目使用 TypeScript 和 Node.js，初期采用普通 CLI 输出，不先引入 React/Ink、插件容器或多包 workspace。

第一阶段采用 ZCode 的依赖方向，但只在一个 npm 包内分层：

```text
bootstrap ──→ core ───────→ contracts
    │                          ↑
    └──→ adapters ─────────────┘
```

箭头表示允许 import 的方向，反向依赖禁止。具体目录：

```text
src/
├── contracts/
│   ├── message.ts            # 文本、assistant 调用、tool 消息和模型请求/响应
│   ├── llm-client.ts         # LlmClient 和稳定错误（含 AgentLoopError）
│   ├── tool.ts               # 工具定义、调用、结果和注册表接口
│   └── agent.ts              # AgentLoopOptions / AgentLoopResult
├── core/
│   ├── runTurnStream.ts      # 流式 turn，完整成功后返回新增消息
│   ├── streamAssembler.ts    # 按 index Map 拼装调用并整批校验
│   ├── loopLimits.ts         # 两种循环共用的 8/4 上限
│   ├── agentLoop.ts          # 非流式兼容路径
│   ├── toolRegistry.ts       # 参数解析、批次校验、工具名称分派
│   └── runPrompt.ts          # 保留阶段 01 的直接无工具调用入口
├── adapters/
│   ├── filesystem/ReadFileTool.ts # 工作区内只读 UTF-8 文件，最大 64 KiB
│   ├── opencode-go/OpenCodeGoClient.ts # complete/stream、请求与资源归属
│   ├── opencode-go/SseParser.ts # fatal UTF-8、行/事件边界
│   ├── opencode-go/streamChunk.ts # SSE JSON 到内部事件
│   └── config/loadConfig.ts  # dotenv、环境变量和默认值
└── bootstrap/
    ├── cli.ts                # 模式、配置、对象组装与退出码
    ├── repl.ts               # 输入、完整 turn 历史与取消
    └── output.ts             # 朴素文本 delta、换行和安全错误
```

各层职责：

- `contracts` 只放稳定的数据结构、接口和错误分类，不调用网络或读取环境变量。
- `core` 放用户场景和 Agent 行为，只依赖 `contracts`，不认识 OpenCode Go 或 Node HTTP 细节。
- `adapters` 实现 `contracts` 定义的接口，负责外部系统、配置和资源边界；不能 import `bootstrap`。
- `bootstrap` 是组合根，创建 adapter 并注入 core，负责 CLI 生命周期；不把业务流程写进参数解析器。

当前调用链为 `bootstrap/cli → REPL 或单次 displayTurn → core/runTurnStream → LlmClient.stream/OpenCodeGoClient → StreamAssembler → ToolRegistry/ReadFileTool → 下一轮流 → 完整结果提交`。配置在一次命令启动时构造，prompt、请求和回答只存在于本次进程内；core 不读取环境变量、不依赖提供方响应格式。OpenCode Go adapter 每次请求生成独立的 `x-opencode-session` 路由 UUID，持有独立超时控制器，并在 `finally` 清理定时器与外部取消监听器。超时覆盖响应体读取，HTTP 诊断只读取最多 512 字节并脱敏。

阶段 02 由 bootstrap 注册并注入 `ReadFileTool`。循环持有完整消息历史和工具结果，执行前整批检查调用 ID、参数 JSON 与 `{path:string}` 结构；结构非法或超过 4 个调用时全部拒绝。工具按顺序执行，可恢复错误回传 tool message，模型请求错误、取消和协议错误直接抛出。第 8 次响应如仍请求工具，跳过最后一批并抛 loop_limit。

文件工具先检查词法路径和真实路径的包含关系，再 stat、打开句柄并有界读取；fatal UTF-8 解码保留原文，空文件允许。真实路径按路径段比较，末端打开使用 O_NOFOLLOW，并再次检查句柄类型与大小；这些检查不能代替操作系统沙箱，也不保证面对工作区父目录并发替换时的原子隔离。

阶段 02 不加入写文件、命令执行、REPL、流式输出或会话存储。阶段 03 已在 `core` 增加流式 turn/assembler，在 adapter 增加 SSE 解析，在 bootstrap 增加 REPL 和朴素 stdout 渲染；历史只存内存，最多保留 20 个完整 user turn。阶段 04 按已评审规格加入会话存储，但仍不拆分多包 workspace，也不新增生产假模型客户端。

### 阶段 03 的流与历史边界

- `complete()` 与非流式 `agentLoop` 保留兼容/测试路径，wire 仍为 `stream:false`；两种 CLI 模式都走 `stream:true`。
- adapter 每请求拥有 reader、fatal UTF-8 decoder、定时器和取消监听；SSE 分片经 parser/chunk 映射为 provider-neutral 事件，未知 reasoning 字段忽略。`usage:null` 不提供统计，用量对象转换为独立事件并去重。
- `StreamAssembler` 为每个 index 保存独立参数字符串，message end 时按 index 排序并全批预检；合法结束且整条 generator 成功完成后才执行工具。`[DONE]` 可选，只有 `[DONE]` 不能成功。
- `runTurnStream` 接收旧历史快照，独占当前 turn 的临时消息；失败只抛稳定异常。`appendedMessages` 仅在完整成功时返回，REPL 将它作为一组保存，超限整组丢弃最旧 turn。
- 文本即时写 stdout，部分屏幕输出不会回滚；成功/失败均补足换行。请求中 Ctrl+C 取消整个 turn，REPL 恢复提示；等待输入时退出 130，单次模式取消退出 4。
- usage-only 兼容缺陷已修复：先区分非空 choices 的消息帧与空 choices + 合法 usage 的统计帧。统计帧只产生独立 usage，不伪造 message_end；等值去重仍属于每请求客户端状态。纯文本和工具往返的真实重跑均收到该统计帧且成功，详情见阶段 03 实际结果。

### 阶段 04 的设计边界（尚未实现）

阶段 04 只为持久化 REPL 增加一条明确的事实交付路径：`bootstrap/repl → core/runPersistentTurn → runTurnStream/ToolRegistry → TurnFactSink → adapters/session/SessionWriter`。普通 `--prompt` 继续走无会话副作用的 `displayTurn`；列表和 picker 只调用 `SessionStore.list`，不加载模型、不创建文件、不修复正文。

规划中的分层保持现有依赖方向：`contracts/session.ts` 定义事实、快照、列表和稳定存储错误；`core` 负责唯一 user/turn_end、取消边界和 `ToolResult → ToolMessage` 投影；`adapters/session` 负责 JSONL 校验、字节扫描、锁、fsync、备份修复和恢复读模型；`bootstrap` 负责模式分流、共享 picker、会话切换和 5 秒故障收尾。adapter 不反向 import core，存储不感知 picker。

会话日志是事实来源，成功模型历史是恢复投影；只有确认 `turn_end(success)` 后，REPL 才提交一组完整消息。失败、取消和中断事实保留在日志，但不自动重跑工具或把未完成 turn 送回模型。具体格式和生命周期见[会话存储契约](contracts/session-store.md)，阶段 04 仍处于设计阶段。

### 依赖检查

`tests/architecture.test.ts` 使用 TypeScript 解析源码模块依赖，并按下表检查；`pnpm test` 同时运行源码和新构建产物的 CLI 验证。构建前清理 `dist`，包入口为 `dist/bootstrap/cli.js`。

| 来源 | 可以依赖 | 禁止依赖 |
| --- | --- | --- |
| `contracts` | Node 无关类型和标准 TypeScript | `core`、`adapters`、`bootstrap`、HTTP、dotenv |
| `core` | `contracts` | `adapters`、`bootstrap`、具体提供方 |
| `adapters` | `contracts`、Node 平台 API、外部 npm 包 | `bootstrap`、CLI 输出和用户交互 |
| `bootstrap` | `core`、`adapters`、`contracts` | 把具体业务规则塞入入口 |

## 核心数据约定

core 与模型 adapter 的内部约定见 [LlmClient 契约](contracts/llm-client.md)；adapter 怎样将它转换成 HTTP headers/body，以及如何把服务响应转换回来，见 [OpenCode Go HTTP 接口契约](contracts/opencode-go-http.md)。后者提供从 prompt 到终端回答的完整示例。

阶段 1 至少需要这些数据：

```text
Message = system | user | assistant
LlmRequest  = { messages, model, ... }
LlmResponse = { message, usage? }
失败通过稳定的 ConfigError / RequestError / ResponseError / AbortError 抛出；循环成功结果见 AgentLoopResult，循环失败抛 AgentLoopError。
```

阶段 2 扩展为：

```text
assistant.toolCalls[]
ToolResult { toolCallId, name, content, ok }
ToolMessage { role: tool, toolCallId, name?, content }
AgentLoopResult { finalText, modelCalls, toolResults, stopKind: final_text }
```

每次工具结果必须使用对应的 `toolCallId`，并在下一次模型请求前追加到历史。模型请求失败、工具失败和循环达到上限属于不同的退出原因。

## 分阶段验收

### 阶段 0：设计与工程初始化

- 说清楚目标场景、调用链、模块职责和失败边界。
- 确认项目名、目录、Node/TypeScript 工具链和第一种模型接入方式。
- 工程初始化并入阶段 1，能运行帮助命令和 mock HTTP 集成验证。

### 阶段 1：单次模型问答

- 终端输入一句话，模型客户端收到正确的消息并返回文本。
- 配置和凭证加载有明确优先级。
- 请求失败能转成可观察的错误结果，进程返回合适的退出码。
- 用本地 mock HTTP 服务覆盖请求组装和错误路径，再用已配置凭证完成真实联调；本阶段不新增假模型客户端。

### 阶段 2：最小 Agent Loop

- 模型能请求 `read_file`。
- 工具参数在执行前校验，文件不存在等错误作为工具结果回传。
- 工具结果进入下一次模型请求，最终回答能引用工具内容。
- 覆盖未知工具、非法参数和循环轮次上限。

### 阶段 3：持续对话与流式输出

- 同一进程中的后续问题携带前文。
- 文本分片按顺序显示，取消和超时有明确结束状态。
- `LlmClient` 保留 `complete()`，新增 provider-neutral 的 `stream()` async generator。
- SSE 工具调用按 index/ID 拼装，完整校验后沿用阶段 02 的顺序执行和 4/8 上限。
- 阶段 03 暂不抽取 OpenAI 兼容基类，REPL 历史和 turn 提交边界由契约明确。

### 阶段 4：会话保存与恢复

- 新进程可以恢复当前工作目录中的会话。
- 恢复后的下一次请求包含旧历史和新问题。
- 中断的工具调用不会被无条件重跑；副作用操作需要先验证状态。

### 阶段 5 及以后：编程能力与扩展

- 按需加入搜索、局部编辑、命令执行、审批和项目规则。
- 在明确需求出现后再评估 MCP、Skill、多 Agent 和更复杂的持久化。

## 每阶段的实现方式

每项功能都遵循同一顺序：先确定可观察场景，再补需要的基础知识，选读少量参考代码，讨论最小设计，分小步实现，最后按阶段规格选择 mock HTTP 或真实服务验证消息、控制流和副作用边界。

测试优先验证领域逻辑和失败路径；CLI 冒烟验证真实接线。参考项目只做阅读对照，本地没有运行它们的完整测试。
