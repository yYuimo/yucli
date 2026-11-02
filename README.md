# yucli

一个从零构建的终端 Agent CLI，用来学习 Agent 的运行机制并逐步完成实际代码任务。

当前支持 REPL 持续对话、流式文本和只读文件工具循环：模型可调用 `read_file` 读取工作区文本，再据此回答。使用 OpenCode Go，默认模型为 `deepseek-v4-flash`。

阶段 03 已完成实现和验证，等待集成审查；设计、实际结果与真实服务限制见[阶段 03 规格](docs/specs/phase-03-repl-streaming.md)。

阶段 04 已实现 T2–T8：持久化 REPL、只读会话列表、共享选择器、直接恢复与继续最近会话。T8 已通过用户验收，T9 已补本机矩阵、真实重启/故障退出及终端证据，仍未签收：用户首轮复核有1项失败，已修正测试请求期限与输出观察条件；原并行 SIGINT 4秒超限未定位，托管 CI 尚未运行。T10 本地预收口完成，最终签收待 CI。阶段保持 implementing；T7/T8/T9 已按用户授权分批提交到阶段分支，阶段分支可按授权推送用于 CI。进度与验证范围见[阶段 04 实际结果](docs/specs/phase-04-session-persistence.md#13-实际结果与下一步)。

## 运行

工具链：Node.js 24.14.0、pnpm 10.33.2，可通过 `.nvmrc` 或 `mise.toml` 选择。

在 `agent-lab/yucli` 目录安装依赖，并在当前目录的 `.env` 设置密钥（已有配置可直接使用）：

```bash
pnpm install --frozen-lockfile
# 首次配置时复制 .env.example 为 .env，填写 OPENCODE_GO_API_KEY
pnpm dev --help
pnpm dev # 持久化 REPL，首次普通问题才创建会话
pnpm dev --sessions # 只读列表，不要求模型密钥
pnpm dev --resume # TTY 中按编号选择
pnpm dev --continue # 当前目录最近非空会话
pnpm dev --prompt "你好"
pnpm dev --prompt "请调用 read_file 读取 README.md，再用三句话总结"
```

构建后也可运行：

```bash
pnpm build
node dist/bootstrap/cli.js --prompt "你好"
```

进程环境变量优先于当前工作目录 `.env`，不向父目录查找配置。端点、模型与请求超时的默认值见 [.env.example](.env.example)。成功回答写入 stdout；错误写入 stderr，退出码为参数错误 2、配置错误 3、模型错误 4、会话访问/保存/关闭故障 5、未预期错误 1。固定注册 `read_file`，只接受工作区相对路径的 UTF-8 普通文件，最大 64 KiB。最多 8 次模型调用、每批 4 个工具调用，按顺序执行；每个 turn 重新计算额度，不提供文件写入。REPL 只在成功后提交历史，保留最近 20 个完整 turn；`/new`（`/clear` 同义）关闭旧会话并清空历史，下一次普通输入创建新会话；`/resume [sessionId|--all]` 切换会话，`/help` 显示命令，`/exit`、`/quit` 或 EOF 正常退出。请求中 Ctrl+C 取消当前 turn 并继续输入，等待输入时 Ctrl+C 退出 130；单次 `--prompt` 取消退出 4。

持久化创建/恢复仅支持 macOS arm64、Node 24.14.0 和本地文件系统，使用 `~/.yucli` 保存私有 JSONL；`--prompt` 不保存。`--sessions [--all]` 显示完整 ID，`--resume <sessionId>` 可非 TTY 直达；无 ID 的 picker 需要 stdin/stdout 都是 TTY，支持 a/r/q。恢复只取最近 20 个完整成功组，不重跑旧工具；其他 cwd 仅预览，需切回原目录恢复。存储故障停止后续输入，30 秒操作等待和 5 秒故障收尾由组合根监督；T9 已验证真实故障退出及重启恢复；托管 CI 的执行结果仍待补齐。

本机全局 Node/pnpm 不符合版本时，可以临时使用项目工具链：

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm dev --prompt "你好"'
```

## 开发验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` 会先清理并构建产物，再检查四层依赖方向、HTTP 协议、源码/产物 CLI、真实进程故障与 PTY 选择器。T9 的终端测试需要 Python 3（仅标准库）、Git 和 macOS 开发工具；不新增 npm 依赖。全套包含真实 30 秒等待/5 秒收尾，通常至少运行约 35 秒。测试只访问本地 mock HTTP/SSE 服务，不读取真实 `.env` 或调用付费模型。真实模型联调单独手动执行，结果见 [阶段 03](docs/specs/phase-03-repl-streaming.md)，阶段 01/02 记录仍保留。

## 代码结构

单个 npm 包内分为四层：`contracts` 定义消息、接口和错误，`core` 实现应用流程，`adapters` 对接配置与 HTTP，`bootstrap` 负责 CLI 组装。`core` 只依赖 `contracts`；依赖方向由测试检查，具体边界见 [架构文档](docs/architecture.md)。

源码已补充面向 TypeScript 学习者的中文注释，建议按以下顺序阅读：

1. [消息类型](src/contracts/message.ts)：先认识模型调用的输入和输出。
2. [客户端接口与错误](src/contracts/llm-client.ts)：理解 Promise 返回值和错误分类。
3. [工具契约](src/contracts/tool.ts)与[循环结果](src/contracts/agent.ts)：认识调用 ID、参数和执行结果。
4. [流式 turn](src/core/runTurnStream.ts)与[拼装器](src/core/streamAssembler.ts)：理解消息提交、交错调用和预算；[非流式循环](src/core/agentLoop.ts)保留兼容路径。
5. [注册表](src/core/toolRegistry.ts)与[文件工具](src/adapters/filesystem/ReadFileTool.ts)：追踪分派、错误回传及路径/字节边界。
6. [CLI 入口](src/bootstrap/cli.ts)、[REPL](src/bootstrap/repl.ts)与[输出函数](src/bootstrap/output.ts)：追踪模式、历史提交、取消和屏幕输出。
7. [配置加载](src/adapters/config/loadConfig.ts)：理解可选值、默认值和运行时校验。
8. [HTTP 客户端](src/adapters/opencode-go/OpenCodeGoClient.ts)：最后结合 [SSE 解析器](src/adapters/opencode-go/SseParser.ts)与[chunk 映射](src/adapters/opencode-go/streamChunk.ts)阅读网络、协议、超时、取消和清理。

后续代码的注释标准见 [协作规范](AGENTS.md#面向学习者的代码注释)。

## 设计原则

- 先做可以追踪输入、输出和状态变化的小功能，再增加抽象。
- 核心循环、模型适配、工具执行、CLI 和存储分别承担清楚的职责。
- 阶段 01 用 mock HTTP 验证实际模型适配器，再单独进行真实模型联调；阶段 03 同样使用真实 adapter + mock SSE，不新增假模型客户端。
- 参考成熟项目的设计问题和边界，不直接搬入它们的完整框架。

更具体的模块边界和阶段验收见 [docs/architecture.md](docs/architecture.md)。

开发过程遵循 [阶段驱动开发规范](docs/development-workflow.md)，接口和数据协议见 [docs/contracts](docs/contracts/README.md)。项目使用 Git 维护，每个阶段的设计和验证结果都保留在对应文档中。
