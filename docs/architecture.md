# yucli 初始架构与开发路线

状态：阶段 01 和阶段 02 已按四层依赖结构实现、验证并完成项目规划审查（`done`）；阶段 03 已验证；阶段 04 保持 `implementing`，T2–T6 已提交，T7 协调/期限/监督与 T8 SessionStore/list、CLI/picker/持久化 REPL 已实现并通过目标环境验证；T7/T8/T9 已于2026-11-02按用户授权分批提交到阶段分支，尚未推送。T9 已补本机矩阵、真实故障退出/重启恢复及终端证据，复核尚未签收，原 SIGINT 超限未定位、托管 CI 尚未运行；T10 完成审查未进行。

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

### 阶段 04 的设计边界（T2–T8 子集已实现）

阶段 04 只为持久化 REPL 增加一条明确的事实交付路径：`bootstrap/repl → core/runPersistentTurn → runTurnStream/ToolRegistry → TurnFactSink → adapters/session/SessionWriter`。普通 `--prompt` 继续走无会话副作用的 `displayTurn`；列表和 picker 只调用 `SessionStore.list`，不加载模型、不创建文件、不修复正文。

已实现分层保持现有依赖方向：`contracts/session.ts` 定义事实、快照、列表和稳定存储错误；`core` 负责唯一 user/turn_end、取消边界和 `ToolResult → ToolMessage` 投影；`adapters/session` 负责 JSONL 校验、字节扫描、锁、fsync、备份修复和恢复读模型；`bootstrap` 负责模式分流、共享 picker、会话切换和 5 秒故障收尾。adapter 不反向 import core，存储不感知 picker。

会话日志是事实来源，成功模型历史是恢复投影；只有确认 `turn_end(success)` 后，REPL 才提交一组完整消息。失败、取消和中断事实保留在日志，但不自动重跑工具或把未完成 turn 送回模型。具体格式和生命周期见[会话存储契约](contracts/session-store.md)，产品接线由下文 T8 完成，完整阶段验收仍归 T9/T10。

阶段 04 T2 已新增 `contracts/session-lock.ts`、`adapters/session/lockPlatform.ts` 与 `SessionLockAdapter.ts`：精确平台/local/native 预检、exnb 写锁、已有文件的 shnb 探测、进程内登记及 dev/ino 所有权复核。release 通过关闭描述符释放，不删除 sidecar；不会提前解锁未 settle 的操作。只有锁调用路径加载 fs-ext，T2 交付时 CLI/REPL 尚未接线；T8 已接入持久化路径。

fs-ext@2.1.1 放 optionalDependencies，pnpm 构建脚本仅授权该包；构建前提和目标 Node 24.14.0 + macOS arm64 的子进程/隔离安装验证见[阶段 04 T2 实际结果](specs/phase-04-session-persistence.md#t2-依赖与锁实际结果2026-10-29)。T2 完成不等于整个存储契约已实现，T7 已补 30 秒存储期限和可注入 5 秒监督，T8 接线；真实退出子进程仍归 T9。

T3 新增 `contracts/session.ts` 的业务数据/稳定错误（锁入口重导出同一异常），以及 adapter 内的 `sessionSchema → sessionSequence` 校验、`jsonPrefix` 与 `scanSession` 字节扫描。扫描器以初始 fstat 固定 `[0,S)`，严格 UTF-8，提供 none/missing_lf/incomplete 与全文件 corrupt/unsupported 拒绝；损坏结果不暴露局部可执行历史。合法结果返回列表统计、工具证据及最近 20 个完整成功业务组，由未来 core 再转模型消息；只读观察不授予写入或恢复执行权。T3 交付时 CLI 尚未接入扫描；扫描自身始终只读。T4/T5 已补 writer/持锁修复，T8 列表复用扫描并在恢复时重新取锁重扫。T3 验证与内存/并发限制见[阶段 04 T3 实际结果](specs/phase-04-session-persistence.md#t3-格式与只读扫描实际结果2026-10-29)。

T3 审查修正把工具终止收窄为 ToolEnd（工具执行失败或两种取消），turn_end 保留完整业务原因；当前不接受工具 timeout。SessionSequence 用失败/完成标志执行单次使用约束，错误后不能生成摘要，finish 后不能再修改已返回读模型。未来 writer/replay 需沿用这些类型和运行时边界；单行/前缀深度仍无硬上限，不把分块扫描当作有界内存。

T4 增加 `contracts/session.ts` 的 SessionWriter/SessionSnapshot/OpenedSession，以及 `SessionFileAdapter → SessionWriterAdapter → sessionFact → sessionSchema/SessionSequence` 新建与追加路径。文件 adapter 在预检后核对 cwd realpath、私有目录与 UUID，取原 T2 锁后 wx 独占创建正文；header/文件/必要目录同步后返回空快照与 writer。writer 深拷贝事实、转换已确认的 assistantId 引用，串行处理短写和 sync，成功才确认 seq；永久故障后不重试不确定行。每个保存检查点复核正文/目录/锁身份。

资源从 create 准备阶段即登记，writer/文件 adapter 的 close 都幂等并等待实际 I/O settle；正文/临时目录 fd 全部关闭成功后才释放 T2 锁，关闭失败继续保留登记和锁。`sessionFileIO` 提供真实 Node I/O 的窄注入，测试使用临时目录及 T3 双扫描 oracle。T4 交付时仅提供新建/writer；下文 T5 追加 openWrite/repair，不修改 core/bootstrap，30 秒/5 秒监督仍待 T7。完整 T4 验证与开发报告记录在阶段规格中，整体阶段没有因此转为 verified。

T5 将已有会话入口限定为 `SessionFileAdapter.openWrite → T2 acquire → SessionWriterAdapter.initializeExisting → scanSessionHandle → 必要时 repairSessionTail → SessionSequence.forAppend`。只读名称定位先排除缺失/多文件，持锁后重新定位并 r+ 打开，无 CREAT/TRUNC/APPEND；复核 cwd、目录/正文身份、权限和大小。扫描借用同一正文 fd，不新增独立扫描句柄；完整文件同步当前合法前缀但不改字节、不备份。业务快照直接取最近 20 个 success、最近 user 摘要及中断统计，不在 adapter 里产生 ToolMessage；纯模型投影归 T6 core。

`repairSession` 为两类尾部先计算原件摘要，按块复制恰好 [0,S)，wx 创建并校验/同步 0600 的完整备份与清单，同步 0700 recovery 各级目录项。修改前再次核对源 dev/ino/大小/时间与 SHA-256，再对原正文 fd 补 LF/截 P、sync、重扫及校验保留前缀摘要。修改前失败不改正文，修改后失败不回滚；所有产物保留。备份/清单/目录 fd 仍归 writer 登记，关闭不确定不能提前解锁。

续写建立新的 T3 校验器，只继承已校验 seq 和旧 turnId 拒绝集合，不复活 finish 后的实例、不重建旧 a1/a2 或工具状态。T4 与 T5 共用 `writeSessionBytes` 短写算法；仅增加内部 read/truncate 注入和受管名称辅助函数。T5 实际完成范围、B06–B09/D04 测试及保留限制见阶段规格；未接入 list、picker、模型事实交付、计时/进程监督或 CLI。

T6 在 `contracts/session.ts` 增加 `TurnFactSink/TurnExecutionContext`；`runTurnStream` 在 signal 后接收可选 context，无上下文的 CLI/兼容调用不变。整条流和批次校验成功后保存 assistant（当前 turn 的 a1/a2），包括最终回答和额度末次合法调用。`executeToolBatch` 逐项等待 start → 注册表 → result，确认后才越过对应屏障；分派前取消保存 cancelled_before_dispatch，已进入的执行按实际原因保存 end。`RegisteredTools` 已取得的合法输出先形成 ToolResult，后续取消不覆盖；真正内部异常用 ToolExecutionError 安全分类，PersistenceError 和 sink 拒绝直接穿透，不递归保存结束。

`core/toolMessage.ts` 是实时、非流式兼容循环和恢复共用的纯转换，只提取模型业务字段，保留原 ToolResult 的 ok 供事实保存。`core/sessionHistory.ts` 消费 T5 的 `RecoveredTurn[]`，返回最多 20 组 success 的 `Message[][]`，整组裁剪并复制嵌套调用；不读写磁盘、不回放模型或工具。adapter 不 import core；T6 交付时未改 bootstrap，T7/T8 已补唯一 user/turn_end、提交凭证与产品历史提交。

T6 新增 2 个测试文件、57 项测试，用本地 mock SSE、可控保存 Promise 和临时 writer/恢复验证屏障及实时/恢复一致性；目标环境全部 17 个文件、749 项及 typecheck/lint/build 通过。该结果仅是 T6 交付时的 core 子集，不能代替后续 T7/T8 验证或 T9 完整阶段验收。

T7 新增 `core/runPersistentTurn`，在保存 user 后桥接 T6 事实 sink，固定唯一 outcome 并保存 turn_end；成功仅返回 contracts 的 CommittedTurnResult，业务失败保存固定安全摘要后重抛原异常，存储失败不写终止或重试。core 不持有时钟、文件身份或退出能力，也不修改 REPL history。

`adapters/session/sessionOperation` 以可注入的单调时钟/定时器提供固定 30 秒公开操作等待，创建器与 writer 共用永久超时状态和继续点 I/O 守卫。preparing/tail 保持原真实 Promise，公开超时不替代资源登记；`SessionCleanup.closeSettled` 等真实操作后关闭正文/备份/目录，再放锁。普通 close 仍有 30 秒上限，closeSettled 只供内部/故障监督使用，不能被解释为资源在超时瞬间已关闭。

`bootstrap/persistenceSupervisor` 注入 stopInput/cancel/真实 close/exit，首次 PersistenceError 固定原分类与 5 秒总期限；及时关闭则返回 5，挂起/关闭失败到期通过注入能力退出 5，重复故障/取消不重置期限，晚到拒绝仍观察。bootstrap 复用 adapter 的默认单调计时能力，依赖方向不变；core/adapter 不调用 process.exit。T7 模块和真实临时存储/锁组合新增 79 项测试，目标环境共 20 文件/828 项及 typecheck/lint/build 通过。T8 已补实际 CLI/REPL 接线，真实故障退出与完整矩阵仍归 T9，T7 本身的验证结论不变。


T8 的生产调用链现在为：`cliOptions → cli → sessionApp → SessionStore.list / 共享 sessionPicker / runRepl`。`SessionFileAdapter.list → listSessions → T3 scanSessionHandle + T2 probe` 只读观察；不建目录/索引/锁、不修复。读 fd 和实际任务与 writer 共用 store 登记及 30 秒总等待，超时后仍等待真实 settle，清理故障不得降级为单文件诊断。header 先按 realpath cwd 过滤，坏文件独立诊断，排序不用 mtime 或伪造时间。

`sessionApp` 在选择目标后才校验启动配置，再 openWrite；continue 不因 busy/unknown/changing 跳过最近有效非空候选。`--prompt` 没有 store/writer，列表与 picker 浏览没有模型配置加载。`LineInput` 独占一个 readline，启动 picker 到 REPL 保留同源队列；picker 编号来自一次快照，仅 a/r 更新，访问拒绝保留编号。I/O 期取消等候选清理，旧 close 开始后不撤销切换。

`runRepl → runPersistentTurn → CommittedTurnResult → 历史整组提交` 已连通。新会话惰性创建；恢复用 core 的 projectSessionHistory，配置提示只在 stderr 首次新请求前出现。/new 与 /clear 关闭旧 writer、清历史，下题才 create；/resume 按准备/关闭/替换顺序，访问拒绝保留旧健康状态。PersistenceError 停输入/取消，由 sessionApp 调用 supervisor 与真实 closeSettled，组合根 cli 注入 process.exit(5)，core/adapter 不直接退出。

T8 新增 4 个测试文件、172 项，目标 macOS arm64/Node 24.14.0/pnpm 10.33.2 全部 24 文件/1000 项及 typecheck/lint/build 通过。源码/构建路径验证只读列表、参数/配置顺序、非 TTY 恢复、真实 busy、D07 故障后停止管道；可控模块测试覆盖共享 picker、候选 I/O/取消、旧 close 屏障和注入退出。真实 5 秒强制退出、重启/崩溃恢复、完整阶段矩阵与人工 TTY 验收仍留 T9，T10 审查未开始。



T9 只增加测试与 CI 定义，生产模块、存储格式和四层依赖不变。`sessionProcess` 用源码/构建 CLI 和真实临时存储做跨进程恢复、成功窗口、配置/目录/worktree 与暂停/死亡锁验收；`sessionProcessFault` 用 tests 专用 preload 注入真实 I/O 确认丢失、未 settle/迟到结果以及修复边界 SIGKILL。公开 30 秒和故障 5 秒计时使用生产实现，确认底层未结束时锁仍 busy、进程退出后可接管；没有给生产 CLI 增加故障环境开关或假模型。

`sessionTerminal` 通过 Python 标准库 PTY 驱动真实 stdin/stdout，验证 picker 编号/刷新、访问竞争、current/all、Ctrl+C/EOF 及只有单边 TTY 时的拒绝。Agent 另用真实终端逐步执行源码建会话→退出→构建产物 picker 恢复和取消，原工具结果未重读、两正文扫描合法且锁已释放；不把它描述为用户本人已操作。

T9 新增 3 个测试文件、56 项，本机全套 27 文件/1057 项及 typecheck/lint/build 通过。新增 `.github/workflows/verify.yml` 固定 macos-15 arm64、Node 24.14.0/pnpm 10.33.2，显式检查 Python/Xcode/native，平台不符直接失败而非 skip；配置通过本地 YAML 解析，托管 job 尚未执行；非目标兼容矩阵覆盖Linux/Windows/macOS Intel/Node22，Node22.22.0反例已在本机单独实跑。用户首轮复核1056/1057，已修正共享60 ms请求期限和跨stdout/stderr管道的测试等待，并增加真实I/O settle阶段诊断与受控管道乱序回归；没有改生产算法或4秒观察窗口。原并行SIGINT超限仍未定位、CI待验，T9保持partial/不能签收，T10 未进入，阶段保持 implementing。

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
