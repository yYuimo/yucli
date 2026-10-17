# yucli 初始架构与开发路线

状态：阶段 01 已按四层依赖结构重新实现并通过开发自验（`verified`），待项目规划 Agent 审查；后续阶段为演进路线。

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
│   ├── message.ts            # Message、LlmRequest、LlmResponse
│   └── llm-client.ts         # LlmClient 和稳定错误类型
├── core/
│   └── runPrompt.ts          # 一次 prompt 的应用流程
├── adapters/
│   ├── opencode-go/
│   │   └── OpenCodeGoClient.ts # OpenAI 兼容 HTTP 客户端
│   └── config/
│       └── loadConfig.ts     # dotenv、环境变量和默认值
└── bootstrap/
    └── cli.ts                # Commander、依赖组装、输出和退出码
```

各层职责：

- `contracts` 只放稳定的数据结构、接口和错误分类，不调用网络或读取环境变量。
- `core` 放用户场景和 Agent 行为，只依赖 `contracts`，不认识 OpenCode Go 或 Node HTTP 细节。
- `adapters` 实现 `contracts` 定义的接口，负责外部系统、配置和资源边界；不能 import `bootstrap`。
- `bootstrap` 是组合根，创建 adapter 并注入 core，负责 CLI 生命周期；不把业务流程写进参数解析器。

当前调用链为 `bootstrap/cli → adapters/config → core/runPrompt → contracts/LlmClient → adapters/opencode-go → CLI 输出`。配置在一次命令启动时构造，prompt、请求和回答只存在于本次进程内；core 不读取环境变量、不依赖提供方响应格式。OpenCode Go adapter 每次请求生成独立的 `x-opencode-session` 路由 UUID，持有独立超时控制器，并在 `finally` 清理定时器与外部取消监听器。超时覆盖响应体读取，HTTP 诊断只读取最多 512 字节并脱敏。

`AgentLoop` 和工具接口在阶段 2 按实际需求加入，`session` 在阶段 4 加入；当前不提前拆成独立 package，也不加入假模型客户端。

### 依赖检查

`tests/architecture.test.ts` 使用 TypeScript 解析源码模块依赖，并按下表检查；`pnpm test` 同时运行源码和新构建产物的 CLI 验证。构建前清理 `dist`，包入口为 `dist/bootstrap/cli.js`。

| 来源 | 可以依赖 | 禁止依赖 |
| --- | --- | --- |
| `contracts` | Node 无关类型和标准 TypeScript | `core`、`adapters`、`bootstrap`、HTTP、dotenv |
| `core` | `contracts` | `adapters`、`bootstrap`、具体提供方 |
| `adapters` | `contracts`、Node 平台 API、外部 npm 包 | `bootstrap`、CLI 输出和用户交互 |
| `bootstrap` | `core`、`adapters`、`contracts` | 把具体业务规则塞入入口 |

## 核心数据约定

阶段 1 至少需要这些数据：

```text
Message = system | user | assistant
LlmRequest  = { messages, model, ... }
LlmResponse = { message, usage? }
失败通过稳定的 ConfigError / RequestError / ResponseError / AbortError 抛出；RunResult 待 Agent Loop 阶段再设计。
```

阶段 2 扩展为：

```text
assistant.toolCalls[]
tool { toolCallId, name, content, isError }
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

- 模型能请求 `readFile`。
- 工具参数在执行前校验，文件不存在等错误作为工具结果回传。
- 工具结果进入下一次模型请求，最终回答能引用工具内容。
- 覆盖未知工具、非法参数和循环轮次上限。

### 阶段 3：持续对话与流式输出

- 同一进程中的后续问题携带前文。
- 文本分片按顺序显示，取消和超时有明确结束状态。

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
