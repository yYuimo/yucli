# CLI 行为契约

状态：`accepted`

阶段 02 扩展状态：`accepted`

阶段 03 扩展状态：`accepted`（阶段 03 已实现并通过本地及真实验证）

阶段 04 扩展状态：`draft`（规格已评审，持久化实现和运行时验收尚未完成）

适用阶段：阶段 01 单次模型问答；阶段 02 单次工具往返；阶段 03 REPL 与流式输出；阶段 04 会话保存与恢复。

## 运行模式与命令形式

阶段 01/02 的 `--prompt` 是一次性命令；阶段 03 无 `--prompt` 时进入 REPL。单次模式和 REPL 共用配置、模型和工具注册，但 REPL 在一个进程中保留内存历史。

组合根为 `src/bootstrap/cli.ts`，构建入口为 `dist/bootstrap/cli.js`。`package.json` 中 `dev`、`start` 和 `bin.yucli` 与这两个入口一致；`bootstrap` 负责创建具体 adapter，固定注册 `read_file` 并传入 core/runTurnStream（阶段 02 的 agentLoop 保留兼容路径）；无额外工具开关或额度 CLI 参数。

```text
yucli --prompt <text>
yucli
yucli --help
```

`--prompt` 执行一次流式 turn，输出最终结果，然后自动终止。空白 prompt 返回退出码 2；非空 prompt 原样传给模型。无 `--prompt` 时进入 REPL；`--help` 输出帮助后立即终止。阶段 01/02 的实现曾把无参数视为用法错误，阶段 03 将其改为 REPL 入口。

## 输出约定

- 成功的 assistant 文本写入标准输出。
- 错误文本写入标准错误。
- 不在输出中显示 API key、Authorization 头或完整请求体。
- 阶段 01/02/03 均不显示 reasoning、HTTP 调试信息、工具参数、SSE 原文或原始 JSON。
- 成功输出后以换行结束。
- 阶段 03 文本 delta 直接按顺序写 stdout；工具调用不直接渲染。

## 退出码

退出码是 CLI 进程结束时交给操作系统、Shell 和自动化脚本的整数结果。它不是 Agent 内部的状态机，也不是持续会话的“退出边界”。阶段 01 的边界是：一次 `--prompt` 请求完成（成功或失败）后进程结束，并用退出码表达结果。

| 退出码 | 名称 | 使用场景 |
| ---: | --- | --- |
| `0` | success | 请求成功并输出 assistant 文本 |
| `2` | usage error | 参数缺失或参数格式错误 |
| `3` | config error | 必填配置缺失或配置值非法 |
| `4` | model/agent error | 单次模式的网络、超时、HTTP、响应解析、循环上限、工具协议或主动取消 |
| `130` | interrupted | REPL 等待输入时收到 Ctrl+C |
| `1` | unexpected error | 未分类的程序错误 |

退出码属于 CLI 边界；内部模块返回稳定错误类型，不直接决定进程退出。阶段 02/03 的 `AgentLoopError`（`loop_limit` 或 `protocol_error`）映射为单次模式退出码 `4`；REPL 当前轮取消后继续等待输入，不立即退出。

## 帮助信息

`--help` 必须说明：

- 命令名称和版本（如果版本已配置）。
- `--prompt <text>` 的用途。
- 阶段 03 帮助信息必须说明无 `--prompt` 会进入 REPL、`/exit`/`/quit`/`/clear`/`/help` 命令和 Ctrl+C 语义。
- 配置通过 `.env` 或进程环境变量提供。

## 配置加载

仅读取启动时当前工作目录的 `.env`，不向父目录查找；进程环境变量优先，包括显式空字符串。必填密钥为空时失败，可选配置为空白时使用默认值。`--help`、`--version` 和参数错误均在配置加载与网络请求前处理。

`OPENCODE_GO_BASE_URL` 接受无内嵌凭证、查询参数和片段的 HTTP(S) URL。`YUCLI_REQUEST_TIMEOUT_MS` 必须为 1—2147483647 的整数毫秒数，覆盖响应体读取。非法配置返回退出码 3，错误不回显配置值。

## 参数优先级

阶段 01 只有 `--prompt`，不允许 CLI 参数覆盖 API key。模型和端点使用环境变量配置，避免凭证出现在 shell 历史和进程参数中。

关联文档：[阶段 01 规格](../specs/phase-01-single-model.md)、[阶段 02 规格](../specs/phase-02-read-file-agent-loop.md)、[阶段 03 规格](../specs/phase-03-repl-streaming.md)、[REPL 契约](repl.md)。

## 阶段 02 运行路径

一次 prompt 可以触发多个模型请求，但仍是一次命令；最多 8 次调用、每批 4 个顺序工具调用。工作区固定为启动 cwd，仅允许最大 64 KiB 的工作区相对 UTF-8 普通文件。无工具的最终文本直接返回；模型先调用工具时只输出循环完成后的 finalText。

成功的工具错误回传并不单独决定退出码：模型看到文件错误后给出最终文本，CLI 仍以 0 结束。AgentLoopError、ResponseError、RequestError 和 AbortError 均映射到 4。无 prompt、配置非法和帮助命令仍在发请求前处理。

## 阶段 03 REPL 与流式路径

无 `--prompt` 时，REPL 读取一行普通文本并调用流式 turn；成功后提交历史并显示下一次提示。`/clear` 清空全部内存历史（历史上限为最近 20 个完整 turn），`/exit`、`/quit`、EOF 返回 0。turn 执行中不读取新输入；流式请求中 Ctrl+C 取消当前 turn、丢弃半截消息并回到提示；等待输入时 Ctrl+C 返回 130。单次 `--prompt` 的取消、超时和流协议错误返回 4。

## 阶段 04 CLI 扩展（draft）

阶段 04 保留 `--prompt` 的无会话副作用，并将无参数入口扩展为惰性创建会话的持久化 REPL。新增入口如下：

```text
yucli
yucli --sessions [--all]
yucli --continue
yucli --resume [sessionId] [--all]
```

`--sessions` 只读列出当前 cwd 的会话，并显示可复制的完整 sessionId；`--all` 扩展初始列表范围但不放宽恢复时的 cwd realpath 约束。无 ID 的 `--resume` 打开共享行式 picker，picker 只按编号选择且不显示 ID；完整 ID 直接恢复，`--continue` 选择当前 cwd 最近的有效非空候选。picker 只在 stdin/stdout 都是 TTY 时可用，编号映射来自一次列表快照；直接 ID 和 `--continue` 不要求 TTY。列表和 picker 不加载模型配置、不创建会话、不修复文件。

阶段 04 的参数互斥和退出码扩展为：参数错误 2、配置错误 3、模型/业务 turn 错误 4、会话访问或持久化/关闭故障 5、等待输入 Ctrl+C 130。`--resume` 的位置参数是可选完整 sessionId；`--all` 只允许搭配 `--sessions` 或不带 ID 的 `--resume`。`--continue` 不接受位置参数。

REPL 增加 `/resume [sessionId]`、`/new` 和同义别名 `/clear`。`/resume` 无参数复用 picker；恢复候选失败时保留当前健康会话并回到 picker。`/new`/`/clear` 关闭旧 writer、清空内存历史并使下一次普通输入惰性创建新会话。picker 中的输入不会被当作普通问题消费；关闭、保存或锁故障优先于正常退出码。

阶段 04 的扩展目前是 `draft`：实现前不得把以上命令、退出码或持久化行为当作已交付能力。具体 JSONL、锁、修复、保存确认和资源所有权见[会话存储契约](session-store.md)。

T7 已实现可注入的 bootstrap/PersistenceSupervisor：首次存储故障固定分类，停止输入/取消业务后等待真实关闭；5 秒内完成返回 5，仍挂起或关闭失败则调用注入 exit(5)。本轮仅验证模块和真实临时存储的组合，不修改 cli.ts/output.ts/repl.ts，不声称当前 CLI 已具备存储退出码/真实强制退出接线；实际组合根、产品命令和退出子进程验收由 T8/T9 完成。

## 阶段 03 实现与验证

入口 [cli.ts](../../src/bootstrap/cli.ts) 使用 [repl.ts](../../src/bootstrap/repl.ts) 持有历史，用 [output.ts](../../src/bootstrap/output.ts) 写文本和安全状态。[cli.test.ts](../../tests/cli.test.ts) 与 [repl.test.ts](../../tests/repl.test.ts) 分别运行源码和构建产物；模型请求由本地 SSE 服务接收，断言 stream:true。非流式 stream:false 的兼容断言继续由 client/toolHttp 测试覆盖。
