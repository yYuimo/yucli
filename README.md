# yucli

一个从零构建的终端 Agent CLI，用来学习 Agent 的运行机制并逐步完成实际代码任务。

当前阶段支持通过 OpenCode Go 完成一次非流式模型问答，默认模型为 `deepseek-v4-flash`。

## 运行

工具链：Node.js 24.14.0、pnpm 10.33.2，可通过 `.nvmrc` 或 `mise.toml` 选择。

在 `agent-lab/yucli` 目录安装依赖，并在当前目录的 `.env` 设置密钥（已有配置可直接使用）：

```bash
pnpm install --frozen-lockfile
# 首次配置时复制 .env.example 为 .env，填写 OPENCODE_GO_API_KEY
pnpm dev --help
pnpm dev --prompt "你好"
```

构建后也可运行：

```bash
pnpm build
node dist/bootstrap/cli.js --prompt "你好"
```

进程环境变量优先于当前工作目录 `.env`，不向父目录查找配置。端点、模型与请求超时的默认值见 [.env.example](.env.example)。成功回答写入 stdout；错误写入 stderr，退出码为参数错误 2、配置错误 3、模型错误 4、未预期错误 1。阶段 01 暂不支持持续对话或工具调用。

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

`pnpm test` 会先清理并构建产物，再检查四层依赖方向、HTTP 协议和源码/产物两条 CLI 路径。测试只访问本地 mock HTTP 服务，不读取真实 `.env` 或调用付费模型。真实模型联调单独手动执行，结果见 [阶段 01](docs/specs/phase-01-single-model.md)。

## 代码结构

单个 npm 包内分为四层：`contracts` 定义消息、接口和错误，`core` 实现应用流程，`adapters` 对接配置与 HTTP，`bootstrap` 负责 CLI 组装。`core` 只依赖 `contracts`；依赖方向由测试检查，具体边界见 [架构文档](docs/architecture.md)。

阶段 01 源码已补充面向 TypeScript 学习者的中文注释，建议按以下顺序阅读：

1. [消息类型](src/contracts/message.ts)：先认识模型调用的输入和输出。
2. [客户端接口与错误](src/contracts/llm-client.ts)：理解 Promise 返回值和错误分类。
3. [单次提问流程](src/core/runPrompt.ts)：看用户输入怎样成为消息。
4. [CLI 入口](src/bootstrap/cli.ts)：追踪参数解析、对象创建、调用和输出。
5. [配置加载](src/adapters/config/loadConfig.ts)：理解可选值、默认值和运行时校验。
6. [HTTP 客户端](src/adapters/opencode-go/OpenCodeGoClient.ts)：最后阅读网络、响应类型守卫、超时、取消和资源清理。

后续代码的注释标准见 [协作规范](AGENTS.md#面向学习者的代码注释)。

## 设计原则

- 先做可以追踪输入、输出和状态变化的小功能，再增加抽象。
- 核心循环、模型适配、工具执行、CLI 和存储分别承担清楚的职责。
- 阶段 01 用 mock HTTP 验证实际模型适配器，再单独进行真实模型联调；后续按阶段需要引入假模型。
- 参考成熟项目的设计问题和边界，不直接搬入它们的完整框架。

更具体的模块边界和阶段验收见 [docs/architecture.md](docs/architecture.md)。

开发过程遵循 [阶段驱动开发规范](docs/development-workflow.md)，接口和数据协议见 [docs/contracts](docs/contracts/README.md)。项目使用 Git 维护，每个阶段的设计和验证结果都保留在对应文档中。
