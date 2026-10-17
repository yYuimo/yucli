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
node dist/cli.js --prompt "你好"
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

测试只访问本地 mock HTTP 服务，不读取真实 `.env` 或调用付费模型。真实模型联调单独手动执行，结果见 [阶段 01](docs/specs/phase-01-single-model.md)。

## 设计原则

- 先做可以追踪输入、输出和状态变化的小功能，再增加抽象。
- 核心循环、模型适配、工具执行、CLI 和存储分别承担清楚的职责。
- 阶段 01 用 mock HTTP 验证实际模型适配器，再单独进行真实模型联调；后续按阶段需要引入假模型。
- 参考成熟项目的设计问题和边界，不直接搬入它们的完整框架。

更具体的模块边界和阶段验收见 [docs/architecture.md](docs/architecture.md)。

开发过程遵循 [阶段驱动开发规范](docs/development-workflow.md)，接口和数据协议见 [docs/contracts](docs/contracts/README.md)。项目使用 Git 维护，每个阶段的设计和验证结果都保留在对应文档中。
