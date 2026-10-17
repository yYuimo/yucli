# 阶段 01：OpenCode Go 单次模型问答

状态：`done`

评审记录：2026-10-17，用户确认本版阶段设计无问题。

这是第一阶段已评审的开发规格。阶段目标是让 yucli 通过 OpenCode Go 的 OpenAI 兼容接口调用 `deepseek-v4-flash`，完成一次最小、可观察、可验证的模型问答。

本阶段不使用假模型。测试使用本地 mock HTTP 服务验证传输和错误处理，真实模型验证使用 `agent-lab/yucli/.env` 中已有的 OpenCode Go 配置。

## 目标场景

用户在终端输入一句话，yucli 组装模型消息，调用 OpenCode Go，取得 assistant 文本并输出到终端。

```text
用户输入
  → CLI 解析
  → 加载 .env 和运行时配置
  → 构造 OpenAI Chat Completions 请求
  → POST {baseUrl}/chat/completions
  → 校验响应并提取 choices[0].message.content
  → 输出回答并结束进程
```

完成后，程序能够使用当前配置调用 OpenCode Go 模型标识 `deepseek-v4-flash`，并在配置缺失、HTTP 失败或响应格式错误时给出可理解的错误和非零退出码。

## 调研结论

本地已有配置：

```text
OPENCODE_GO_BASE_URL=https://opencode.ai/zen/go/v1
OPENCODE_GO_API_KEY=<secret>
```

本地 OpenCode 日志和 `mcp-test-agent` 的已有实现都使用以下协议：

- 请求：`POST {baseUrl}/chat/completions`。
- 认证：`Authorization: Bearer <api-key>`。
- 服务路由：`x-opencode-session: <uuid>`，阶段 01 每次请求生成独立 UUID；见 [ADR-002](../decisions/ADR-002-opencode-session-routing.md)。
- 请求体至少包含 `model` 和 `messages`；第一阶段固定 `stream: false`。
- 当前模型标识：`deepseek-v4-flash`。
- 成功响应从 `choices[0].message.content` 读取文本。
- `usage.prompt_tokens`、`usage.completion_tokens` 可以保留为可选统计。

对 `GET {baseUrl}/models` 的本地探测返回了 HTTP 403，因此第一阶段不依赖模型列表接口，也不把它作为启动检查。模型名由配置默认值提供；真正的可用性以 Chat Completions 请求为准。

## 运行时与依赖

### 固定工具链

参考 ZCode 和现有 `paicli-ts` 的工具链，第一阶段固定为：

```text
Node.js 24.14.0
pnpm 10.33.2
TypeScript ESM
```

项目应提交 `.nvmrc`、`mise.toml` 和 `packageManager` 配置，保证本地安装和 CI 使用同一套基础工具。依赖的精确版本由 `pnpm-lock.yaml` 固定。

### 初始 npm 包

运行时依赖：

| 包 | 用途 | 选择理由 |
| --- | --- | --- |
| `commander` | 解析 `--prompt`、`--help` 等 CLI 参数 | CLI 行为清楚，后续可扩展子命令 |
| `dotenv` | 读取项目根目录 `.env` | 使用现有本地配置，不把密钥写入代码 |

开发依赖：

| 包 | 用途 |
| --- | --- |
| `typescript` | 类型检查和编译 |
| `tsx` | 开发期直接运行 TypeScript CLI |
| `vitest` | 单元测试和本地 mock HTTP 测试 |
| `@types/node` | Node.js 24 类型定义 |
| `eslint`、`@eslint/js`、`typescript-eslint` | 代码检查 |

第一阶段使用 Node 24 原生 `fetch`、`AbortController` 和 `node:process`，不引入 `axios`、`openai` SDK 或其他 HTTP 客户端。这样可以直接看清请求、响应、错误和取消边界。第一阶段也不引入 `zod`；响应校验先用明确的 TypeScript 类型守卫实现，后续出现多提供方或复杂结构时再评估 schema 库。

## 范围

### 包含

- 初始化 Node 24 + TypeScript ESM CLI 工程。
- 使用 OpenCode Go 的 `deepseek-v4-flash` 完成一次非流式请求。
- `Message`、`LlmRequest`、`LlmResponse` 和 `LlmClient` 的最小契约。
- 加载 `.env` 和进程环境变量。
- 配置校验、请求超时、HTTP 错误和响应格式校验。
- 使用本地 mock HTTP 服务覆盖传输和错误路径。
- 使用真实 OpenCode Go 配置完成一次 CLI 联调。

### 不包含

- 假模型客户端。
- 工具声明、工具执行和 Agent Loop。
- 多轮历史、会话保存与恢复。
- 流式响应、SSE、用户取消和重试队列。
- REPL、斜线命令、TUI 或 Markdown 渲染。
- MCP、Skill、多 Agent、规划和上下文压缩。

## 验收场景

### 成功路径：真实 OpenCode Go

**给定**：`OPENCODE_GO_API_KEY` 已配置，`OPENCODE_GO_BASE_URL` 可访问。

**当**：用户使用 `--prompt "你好"` 发起一次提问。

**那么**：

- 请求地址为 `{baseUrl}/chat/completions`。
- 请求带有 `Authorization: Bearer ...`、`Content-Type: application/json` 和独立 UUID 的 `x-opencode-session`。
- 请求体包含 `model: "deepseek-v4-flash"`、正确的 user message 和 `stream: false`。
- CLI 输出 `choices[0].message.content`，不输出 reasoning 字段或密钥。
- 进程以退出码 `0` 结束。

### 配置错误

**给定**：`OPENCODE_GO_API_KEY` 缺失或为空。

**那么**：

- 在发起网络请求前失败。
- 错误指出缺少 `OPENCODE_GO_API_KEY`。
- 进程返回非零退出码。

`OPENCODE_GO_BASE_URL` 缺失时使用 `https://opencode.ai/zen/go/v1`；模型名缺失时使用 `deepseek-v4-flash`。

### HTTP 或网络错误

**给定**：服务不可达、超时或返回非 2xx 状态码。

**那么**：

- 错误被转换成稳定的 yucli 模型请求错误。
- 错误包含请求阶段和 HTTP 状态；错误响应体最多保留 512 字节。
- 不输出 Authorization 头或 API 密钥。
- 进程返回非零退出码。

### 响应格式错误

**给定**：服务返回 2xx，但 JSON 缺少 `choices[0].message.content` 或字段类型错误。

**那么**：

- 客户端拒绝响应并返回明确的响应解析错误。
- CLI 不输出伪造的 assistant 文本。
- 进程返回非零退出码。

## 设计

### 模块和调用链

第一阶段采用单包四层目录，不拆成 ZCode 式多包 workspace：

```text
bootstrap ──→ core ───────→ contracts
    │                          ↑
    └──→ adapters ─────────────┘
```

第一阶段目录：

```text
src/
├── contracts/
│   ├── message.ts            # Message、LlmRequest、LlmResponse
│   └── llm-client.ts         # LlmClient 和稳定错误类型
├── core/
│   └── runPrompt.ts          # 一次提问的应用服务
├── adapters/
│   ├── opencode-go/
│   │   └── OpenCodeGoClient.ts # OpenAI 兼容非流式客户端
│   └── config/
│       └── loadConfig.ts     # dotenv、环境变量和默认值
└── bootstrap/
    └── cli.ts                # Commander、依赖组装、输出和退出码
```

箭头表示允许 import 的方向，反向依赖禁止。`contracts` 不调用外部系统，`core` 不知道 OpenCode Go，`adapters` 不依赖 CLI，`bootstrap` 只负责组装和进程生命周期。

职责约定：

- `bootstrap/cli.ts` 负责读取参数、创建 adapter、调用 core、输出结果和设置退出码。
- `core/runPrompt.ts` 负责把用户输入转换为消息并调用 `LlmClient`。
- `adapters/opencode-go/OpenCodeGoClient.ts` 负责 URL、HTTP、认证、超时、响应读取和协议校验，不负责打印终端文本。
- `adapters/config/loadConfig.ts` 负责读取和校验配置，不把环境变量读取散落到客户端中。
- `contracts` 中的 `LlmClient` 是 core 和具体客户端之间的唯一边界。

### 配置契约

```text
OPENCODE_GO_API_KEY       必填；只放入 Authorization 请求头
OPENCODE_GO_BASE_URL      可选；默认 https://opencode.ai/zen/go/v1
OPENCODE_GO_MODEL         可选；默认 deepseek-v4-flash
YUCLI_REQUEST_TIMEOUT_MS  可选；默认 120000
```

`dotenv` 读取 `yucli` 当前工作目录的 `.env`；已经存在的进程环境变量优先于 `.env`。`.env` 必须被 `.gitignore` 忽略。配置对象在启动时一次性构造并传入客户端。

### OpenAI 兼容请求

```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "user", "content": "你好" }
  ],
  "stream": false
}
```

第一阶段不主动传 `temperature`、工具、response format 或其他提供方扩展字段。这样可以先确认最小协议；后续需要时通过明确的契约和 ADR 增加。

### 最小领域数据

```ts
type MessageRole = "system" | "user" | "assistant";

interface Message {
  role: MessageRole;
  content: string;
}

interface LlmRequest {
  model: string;
  messages: Message[];
}

interface LlmResponse {
  message: {
    role: "assistant";
    content: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
```

OpenCode Go 的 `reasoning_content` 即使存在，也不作为第一阶段的最终文本输出；客户端只提取 `message.content`，不保留原始响应，也不把密钥或完整响应写入普通日志。

### 错误边界

错误至少分为三层：

```text
配置错误       # 请求还没有开始
模型请求错误   # 网络、超时或 HTTP 非 2xx
响应解析错误   # HTTP 成功但响应不符合 OpenAI 兼容结构
```

客户端把底层错误转换为稳定的错误类型或错误码；CLI 把它转换成用户可读文本和退出码。错误消息不能依赖某个 HTTP 库的原始异常格式。

## 默认决策与备选方案

本阶段不留下没有方向的空白选择。默认方案直接作为实现依据；如果后续需要更换，必须在阶段文档或 ADR 中说明影响。

| 设计点 | 默认决策 | 备选方案与取舍 |
| --- | --- | --- |
| CLI 输入 | 使用 `--prompt <text>`，同时提供 `--help` | 支持位置参数更短，但参数歧义更大；交互 REPL 延后到阶段 3 |
| 模型客户端 | 自己用原生 `fetch` 实现 OpenAI 兼容客户端 | 使用 `openai` SDK 可少写协议代码，但会隐藏请求边界并增加提供方适配约束 |
| `.env` | 使用 `dotenv`，进程环境变量优先 | 只用环境变量更简单，但本地开发不方便；配置文件体系延后 |
| 模型 | 默认 `deepseek-v4-flash`，允许 `OPENCODE_GO_MODEL` 覆盖 | 固定模型最简单，但无法切换测试模型；不在第一阶段做模型发现 |
| 请求模式 | 非流式 `stream: false` | SSE 更快显示，但会引入异步迭代和分片状态，放到阶段 3 |
| 请求超时 | `YUCLI_REQUEST_TIMEOUT_MS` 默认 120 秒 | 不设超时会让 CLI 无限等待；更细的取消原因放到后续阶段 |
| 响应校验 | 手写最小类型守卫 | `zod` 更完整，但当前结构很小，先不引入运行时 schema 依赖 |
| System message | 第一阶段不主动添加 | 添加固定 system prompt 有利于控制角色，但会增加第一条消息的设计约束；项目规则阶段再引入 |
| HTTP 错误体 | 最多记录 512 字节 | 记录完整响应便于调试，但可能泄露服务端信息或造成日志膨胀 |

## 开发前评审补充（2026-10-17）

已确认可以直接实现，范围与接口无阻塞问题。统一和补充如下：

- 本阶段按本规格使用 mock HTTP 服务验证真实适配器，再做一次真实模型联调；替代早期路线中的假模型示例要求。
- 阶段状态遵循 `designed → implementing → verified → done`；契约和 ADR 的 `accepted` 状态保持不变。
- `.env` 明确相对于启动时的当前工作目录，不向父目录搜索；帮助命令与参数错误不加载配置、不发请求。
- 空白 prompt 返回退出码 2，原始非空 prompt 保持原样传给模型。
- 空白可选配置使用默认值；URL 只接受无凭证、查询参数和片段的 HTTP(S) 地址；超时为 1—2147483647 的整数毫秒数。
- 超时覆盖连接、响应头和响应体读取全过程；调用方取消与超时按先触发者区分。CLI 暂不增加取消交互。
- 成功响应必须有 assistant role 和非空白 content；可选 token 统计存在时必须为非负整数。
- 非 2xx 诊断摘要最多读取 512 字节，脱敏密钥及 Authorization/Bearer 内容、去除控制字符，再限制输出为 512 字节；不跟随重定向。
- 不保留原始响应调试副本，减少无用途的敏感数据留存。
- 真实联调发现原计划缺少 `x-opencode-session` 路由头；首个请求返回 HTTP 400 `MissingSessionID`。按服务提示补充每次请求独立 UUID，不改变公共 `LlmRequest`，不引入会话存储；决策见 ADR-002。

## 任务清单

- [x] 评审本阶段默认决策和 OpenCode Go 模型标识。
- [x] 创建 `.nvmrc`、`mise.toml` 和 `package.json`，固定 Node 24.14.0、pnpm 10.33.2 和 ESM。
- [x] 安装并锁定 `commander`、`dotenv`、`typescript`、`tsx`、`vitest`、`@types/node` 和 ESLint 依赖。
- [x] 定义 `Message`、`LlmRequest`、`LlmResponse`、`LlmClient` 和稳定错误类型。
- [x] 实现配置读取、默认值和必填项校验。
- [x] 实现 `OpenCodeGoClient` 的非流式请求、超时和响应校验。
- [x] 实现一次提问的应用服务和 `--prompt` CLI。
- [x] 用本地 mock HTTP 服务覆盖请求组装、HTTP 错误、超时和错误 JSON。
- [x] 使用现有 `.env` 完成一次真实 OpenCode Go 联调。
- [x] 更新本阶段文档的实际结果和遗留问题。

## 验证计划

### 自动检查

- TypeScript 类型检查。
- ESLint。
- Vitest：配置校验、请求 URL/headers/body、成功响应、HTTP 错误、超时和响应解析错误。

### CLI 检查

- 使用本地 mock HTTP 服务执行 `--prompt`，确认输出和退出码。
- 缺少 `OPENCODE_GO_API_KEY` 时确认不发网络请求并返回非零退出码。
- 确认错误输出不包含 API 密钥。

### 真实联调

- 使用 `agent-lab/yucli/.env` 的现有配置调用 `deepseek-v4-flash`。
- 只记录请求是否成功、模型标识和输出是否非空，不记录 API 密钥或完整敏感响应。
- 如果服务端返回“模型需要显式开通/地区选择”等业务错误，保留安全的状态码和错误摘要，并把它作为配置或服务资格问题处理。

## 实际结果

2026-10-17，阶段 01 开发与验收完成，由助手实现并运行验证；不等于学习者已独立实现或掌握。

- 建立 Node 24.14.0 / pnpm 10.33.2 的 TypeScript ESM 工程，运行时依赖为 Commander 和 dotenv，HTTP 使用原生 fetch。
- 完成消息与 LlmClient 类型、稳定错误、配置加载、单次提问服务、OpenCode Go 客户端和 CLI。
- 成功输出 assistant 文本；拒绝空白输入、非法配置、HTTP/网络失败、超时和非法响应；错误诊断限长、脱敏，资源按请求清理。
- 真实联调暴露并修复缺少 `x-opencode-session` 的问题，见 ADR-002。未新增工具、Agent Loop、流式或持久化功能。
- 依赖安装时发现最新 TypeScript 超出 TypeScript ESLint 的支持范围，采用 `~6.0.3`，搭配 ESLint 10，具体解析版本由锁文件固定。

### 验证命令与结果

所有运行检查均使用 Node 24.14.0 和 pnpm 10.33.2。在本机全局版本不匹配时，使用：

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm <命令>'
```

| 检查 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件与依赖一致 |
| `pnpm typecheck` | 通过，包含源码和测试的 TypeScript 检查 |
| `pnpm lint` | 通过 |
| `pnpm test` | 3 个测试文件、51 项测试通过；只访问本地 mock HTTP，不使用真实凭证 |
| `pnpm build` | 通过，产物为 `dist/cli.js` 等 ESM 文件 |
| CLI 子进程测试 | 成功输出与退出码 0、帮助不依赖密钥、参数错误 2、配置错误 3、HTTP/响应错误 4；无请求场景检查服务命中次数为 0 |
| `node dist/cli.js --help` | 构建产物帮助信息和退出码验证通过 |
| 真实模型 CLI | 使用当前目录已有 `.env` 调用 `deepseek-v4-flash`，退出码 0、stdout 非空、stderr 为空，耗时约 5.07 秒；不记录密钥或完整回答 |
| 文件检查 | 本地文档链接、代码围栏、空白格式及 `.env`/产物忽略规则已检查 |

传输测试覆盖 URL、认证、路由 UUID、消息原样传输、usage 映射、请求对象不变、HTTP 错误、诊断截断与脱敏、响应体停顿、无效 JSON/响应结构、外部取消、独立请求生命周期、网络断开和重定向拒绝。

真实请求首次返回 HTTP 400 `MissingSessionID`，根据服务要求补充路由头后成功；该问题已解决。此前 `/models` 返回 403，程序继续不依赖该接口。服务错误链接所指文档的直接抓取也返回 403，路由头要求依据真实响应，未将未能访问的文档作为已核实依据。

### 遗留问题与下一步

本阶段验收无遗留阻塞问题。真实验证仅覆盖当前账号、当前端点和该模型的一次成功问答，不代表其他模型或平台均已验证。

下一步先按调用链讲解当前实现，再设计阶段 02 的只读文件工具和最小 Agent Loop。加入持续对话时需重新设计服务路由 ID 与本地会话 ID 的生命周期；不直接沿用逐请求 UUID。
