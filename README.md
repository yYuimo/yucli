# yucli

一个从零构建的终端 Agent CLI，用来学习 Agent 的运行机制并逐步完成实际代码任务。

当前支持 REPL 持续对话、流式文本和只读文件工具循环：模型可调用 `read_file` 读取工作区文本，再据此回答。使用 OpenCode Go，默认模型为 `deepseek-v4-flash`。

阶段 03 已完成实现和验证，等待集成审查；设计、实际结果与真实服务限制见[阶段 03 规格](docs/specs/phase-03-repl-streaming.md)。

阶段 04 当前完成 T2 原生锁、T3 JSONL 类型/只读扫描、T4 文件与 writer，以及 T5 存储恢复/修复，尚未接入持久化 CLI；运行入口仍使用阶段 03 的内存历史。纯模型消息投影归入 T6 core 任务。进度与验证范围见[阶段 04 实际结果](docs/specs/phase-04-session-persistence.md#13-实际结果与下一步)。

## 运行

工具链：Node.js 24.14.0、pnpm 10.33.2，可通过 `.nvmrc` 或 `mise.toml` 选择。

在 `agent-lab/yucli` 目录安装依赖，并在当前目录的 `.env` 设置密钥（已有配置可直接使用）：

```bash
pnpm install --frozen-lockfile
# 首次配置时复制 .env.example 为 .env，填写 OPENCODE_GO_API_KEY
pnpm dev --help
pnpm dev # 无 --prompt 时进入 REPL
pnpm dev --prompt "你好"
pnpm dev --prompt "请调用 read_file 读取 README.md，再用三句话总结"
```

构建后也可运行：

```bash
pnpm build
node dist/bootstrap/cli.js --prompt "你好"
```

进程环境变量优先于当前工作目录 `.env`，不向父目录查找配置。端点、模型与请求超时的默认值见 [.env.example](.env.example)。成功回答写入 stdout；错误写入 stderr，退出码为参数错误 2、配置错误 3、模型错误 4、未预期错误 1。固定注册 `read_file`，只接受工作区相对路径的 UTF-8 普通文件，最大 64 KiB。最多 8 次模型调用、每批 4 个工具调用，按顺序执行；每个 turn 重新计算额度，不提供文件写入。REPL 只在成功后提交历史，保留最近 20 个完整 turn；`/clear` 清空历史，`/help` 显示命令，`/exit`、`/quit` 或 EOF 正常退出。请求中 Ctrl+C 取消当前 turn 并继续输入，等待输入时 Ctrl+C 退出 130；单次 `--prompt` 取消退出 4。

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

`pnpm test` 会先清理并构建产物，再检查四层依赖方向、HTTP 协议和源码/产物两条 CLI 路径。测试只访问本地 mock HTTP/SSE 服务，不读取真实 `.env` 或调用付费模型。真实模型联调单独手动执行，结果见 [阶段 03](docs/specs/phase-03-repl-streaming.md)，阶段 01/02 记录仍保留。

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
