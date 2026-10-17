# CLI 行为契约

状态：`accepted`

适用阶段：阶段 01 单次模型问答。

## 运行模式与命令形式

阶段 01 是一次性命令：每次进程只处理一个 prompt。请求成功或失败后，进程都会结束；持续输入和多轮对话属于后续阶段。

组合根为 `src/bootstrap/cli.ts`，构建入口为 `dist/bootstrap/cli.js`。`package.json` 中 `dev`、`start` 和 `bin.yucli` 与这两个入口一致；`bootstrap` 负责创建具体 adapter 并传入 core。

```text
yucli --prompt <text>
yucli --help
```

`--prompt` 执行一次模型请求，输出结果，然后自动终止。空白 prompt 返回退出码 2；非空 prompt 原样传给模型。`--help` 输出帮助后立即终止。阶段 01 不支持无参数 REPL；没有提供 `--prompt` 时显示用法并返回参数错误退出码。

## 输出约定

- 成功的 assistant 文本写入标准输出。
- 错误文本写入标准错误。
- 不在输出中显示 API key、Authorization 头或完整请求体。
- 阶段 01 不显示 reasoning、HTTP 调试信息或原始 JSON。
- 成功输出后以换行结束。

## 退出码

退出码是 CLI 进程结束时交给操作系统、Shell 和自动化脚本的整数结果。它不是 Agent 内部的状态机，也不是持续会话的“退出边界”。阶段 01 的边界是：一次 `--prompt` 请求完成（成功或失败）后进程结束，并用退出码表达结果。

| 退出码 | 名称 | 使用场景 |
| ---: | --- | --- |
| `0` | success | 请求成功并输出 assistant 文本 |
| `2` | usage error | 参数缺失或参数格式错误 |
| `3` | config error | 必填配置缺失或配置值非法 |
| `4` | model error | 网络、超时、HTTP 错误或响应解析错误 |
| `1` | unexpected error | 未分类的程序错误 |

退出码属于 CLI 边界；内部模块返回稳定错误类型，不直接决定进程退出。

## 帮助信息

`--help` 必须说明：

- 命令名称和版本（如果版本已配置）。
- `--prompt <text>` 的用途。
- 当前阶段不支持交互 REPL。
- 配置通过 `.env` 或进程环境变量提供。

## 配置加载

仅读取启动时当前工作目录的 `.env`，不向父目录查找；进程环境变量优先，包括显式空字符串。必填密钥为空时失败，可选配置为空白时使用默认值。`--help`、`--version` 和参数错误均在配置加载与网络请求前处理。

`OPENCODE_GO_BASE_URL` 接受无内嵌凭证、查询参数和片段的 HTTP(S) URL。`YUCLI_REQUEST_TIMEOUT_MS` 必须为 1—2147483647 的整数毫秒数，覆盖响应体读取。非法配置返回退出码 3，错误不回显配置值。

## 参数优先级

阶段 01 只有 `--prompt`，不允许 CLI 参数覆盖 API key。模型和端点使用环境变量配置，避免凭证出现在 shell 历史和进程参数中。

关联文档：[阶段 01 规格](../specs/phase-01-single-model.md)。
