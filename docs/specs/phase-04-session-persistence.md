# 阶段 04：会话保存与恢复

状态：`implementing`

规格日期：2026-10-27（Asia/Shanghai）。工作分支：`phase/04-session-persistence`。

交互修订：2026-10-28（Asia/Shanghai）。参考 Codex CLI/Pi 的恢复入口，改为默认选择器、继续最近会话与已知 ID 直达；新增 `/new`，保留 `/clear` 别名。规格已完成评审；2026-10-29 按独立授权完成 T2 锁、T3 扫描、T4 文件/writer、T5 存储恢复/修复及 T6 core 交付/纯模型投影。T5/T6 已通过验证，并获用户授权分开提交，阶段保持 `implementing`，T7–T10 未开始。

用户已确认调研可以收口并完成本规格评审；本文件把[会话持久化调研报告](../research/session-persistence-research.md)第 9 章整理成可实施、可验收的规格。当前实现 T1–T6 的授权范围，不将调研探针、存储或 core 子集验证视为整个阶段的应用验收；T5 仅交付成功 turn 的业务快照，T6 交付纯模型消息投影，不包含 T7 协调器或 T8 接线。

规格评审后转为 `designed`，开始实现时转为 `implementing`。格式、跨进程写者和恢复策略的理由见 [ADR-006](../decisions/ADR-006-session-persistence.md)，该决策已接受；阶段 04 的新增契约在实现和验证前保持 `draft`。现有阶段 01–03 的 accepted 契约仍描述已实现行为；本阶段实现必须同步更新受影响契约和架构，再经验证接受扩展。

## 1. 目标场景

用户在一个工作目录运行 `yucli`，完成普通问答或 `read_file` 工具往返后退出；重新启动进程，可以列出并恢复同一目录中的会话。下一次模型请求携带最近的完整成功历史和新问题。

进程在模型或工具执行期间中断时，保留已确认的执行事实。恢复能区分已取得的结果、已知异常、未开始和结果未知；不自动继续旧 turn、不重跑工具，也不把失败或半截对话送回模型。

完成标准包括保存成功的证据：完整结果和 `turn_end(success)` 都完成文件同步后，REPL 才提交历史。屏幕显示了文本不代表保存已经成功。

## 2. 范围

### 包含

- REPL 自动持久化，首次非空普通输入惰性创建会话；退出、重启、只读列表、行式恢复选择器、继续最近会话，以及 `/new`（`/clear` 别名）切换新会话。
- UTF-8 JSONL v1：header、user/assistant 消息、工具开始/结果/异常终止、turn 终止。
- core 的有序、可等待业务事实交付；逐项保存工具结果，保留 `ToolResult.ok`。
- 成功 turn 的模型历史投影、最近 20 个成功 turn 的完整分组窗口。
- 单进程串行写入与跨进程内核锁，覆盖整个可写会话生命周期。
- 文件与必要目录同步、严格扫描、尾部分类、修复前完整备份、修复后重验。
- 提供方/模型变化提示，安全存储错误、退出码和关闭等待边界。
- 为以上行为调整旧代码，并用受控保存器、本地 mock SSE、临时目录和子进程验证。

### 不包含

- 普通 `--prompt` 的会话保存，任意路径导入/恢复、跨 cwd 恢复或目录迁移。
- 旧 turn 自动续跑、工具重放、写入重试、eventId 去重或 exactly-once 保证。
- 并发工具、steering、编辑旧消息、分支、树导航、回滚。
- SQLite、持久化索引、分页、后台缓存、compaction、token 预算、文件轮换。
- 全屏 TUI、方向键导航、Tab/Esc 快捷键、会话搜索/重命名及完整 transcript 预览；v1 picker 复用首条 user 摘要，不新增 `/sessions` 命令。
- 删除/归档命令、自动清理锁或备份、保留期限、配额、备份自动还原、语义损坏自动修复。
- endpoint/system/tools 指纹、usage 和 reasoning 的持久化、逐 token 日志。
- 会话加密及对任意不可信日志的完整 DoS 防护。
- Linux、Windows、macOS Intel、其他 Node 版本和共享文件系统的持久化支持。

持久化创建/恢复的 v1 支持范围为 **macOS arm64 + Node 24.14.0 + 本地文件系统**。平台/Node 检查在产生持久化副作用前完成；共享文件系统不在支持承诺内，不声称能识别所有挂载类型。未验证环境拒绝创建/恢复，不自动换锁方案。普通 `--prompt`、帮助、版本和只读列表不因此被提前禁用。

本阶段不设单条记录字节硬上限。扫描、复制按块进行，但单条消息、JSON 行、残片识别和当前 turn 仍可能占用大量内存；20-turn 窗口不是字节上限。未来若增加上限，写入和读取必须采用一致的 UTF-8 字节规则，不能只在恢复端拒绝自己写出的文件，或把超限记录当残片截断。

## 3. CLI、REPL 和可观察行为

### 命令与参数

| 入口 | 行为 |
| --- | --- |
| `yucli` | 新 REPL；首次普通输入才创建会话 |
| `yucli --prompt <text>` | 一次流式 turn，不创建会话或锁目录 |
| `yucli --sessions` | 只读列出 header.cwd 等于当前 cwd realpath 的会话，不需要模型密钥 |
| `yucli --sessions --all` | 全局只读列表；其他 cwd 标为仅预览，需切换原目录才能恢复 |
| `yucli --continue`、`yucli -c` | 按下文规则选当前 cwd 最近的非空候选，直接恢复，不打开 picker |
| `yucli --resume`、`yucli -r` | 打开当前 cwd 的会话选择器，不要求用户先知道 ID |
| `yucli --resume --all`、`yucli -r --all` | 选择器初始显示全局会话及 cwd；其他目录只预览 |
| `yucli --resume <sessionId>`、`yucli -r <sessionId>` | 已知完整 ID 时直接恢复；取得写入权、重扫并准备成功后进入 REPL |
| `/resume`、`/resume --all` | 闲置 REPL 打开同一选择器，默认 current，--all 初始为全局范围 |
| `/resume <sessionId>` | 闲置 REPL 直接切换；准备候选成功后才关闭旧会话、替换历史 |
| `/new`、`/clear` | 完全相同：关闭旧会话、清空上下文并转回待创建；下次普通输入使用新 sessionId，旧文件保留 |
| `/exit`、`/quit`、EOF | 不再接受输入，完成已接受 turn 的收尾，关闭资源；正常退出 0 |
| 普通 REPL 提示符闲置 Ctrl+C | 关闭会话后退出 130；关闭失败则退出 5；picker 内另按选择器规则 |
| 活跃 Ctrl+C | 取消当前 turn；非成功终止保存确认后继续 REPL，存储失败则退出 5 |
| `/help`、空行 | 不发模型请求、不实体化新会话；帮助主推 /new，并说明 /clear 是同义别名 |

四种显式模式 `--prompt`、`--sessions`、`--resume`、`--continue` 两两互斥，无这些参数则新建 REPL。`--resume [sessionId]` 的参数是可选的：未给 ID 进入 picker，显式空字符串仍非法。`--all` 只允许搭配 `--sessions` 或**不带 ID 的** `--resume`，与 `--continue`、直接 ID 恢复或单独使用均为用法错误 2。`--continue` 不接受位置参数，也不隐式附带 prompt。

缺少必填参数、多余参数、空白 prompt、空白或不安全的 sessionId 均在加载模型配置和创建文件前返回用法错误 2。REPL 内 `/resume` 无参数合法；非法 ID、未知选项、多余参数及 `/new`/`/clear` 带参只报告命令用法并保留当前会话，不发送给模型。其他未知斜杠输入继续沿用原有普通文本行为；本阶段不注册 `/sessions`。

直接按 ID 恢复要求完整 sessionId，不支持短前缀、名称匹配或任意文件路径。picker 只显示序号、时间、摘要和状态，用户按编号选择，内部再映射到完整 ID；picker 不显示 ID，也不提供额外的 ID 查看命令。`--sessions` 列表显示可复制的完整 sessionId，供 `--resume <sessionId>` 和脚本使用，不提供短 ID 作为恢复输入。身份须非空，且用于路径的 sessionId 限定为 1–128 个 ASCII 字母、数字、`_`、`-`，首字符为字母或数字；新建始终生成 UUID v4。日志中的教学占位身份可符合该安全字符规则，不以“不是 UUID”为由忽略其他校验。

显式恢复在首次新请求前向 stderr 报告 sessionId、已恢复成功 turn 数及中断/尾部处理摘要，不自动重印完整历史或工具内容；恢复空会话允许继续。正常新会话创建后在 stderr 给出完整 sessionId，方便后续选择。stdout 保持文本流、REPL 提示、命令帮助和用户主动请求的列表；不打印原始 JSON、SSE、工具参数或 reasoning。

启动参数和 picker 的 TTY 检查在读取会话/模型配置之前；`--sessions` 与 picker 浏览不调用模型配置加载器。CLI 启动 picker 确认选择、或 continue 解析出候选后，才加载启动环境的 `.env` 和模型配置，配置失败为 3，且尚未取得候选写锁或修复文件。REPL 内 picker 复用启动时已经加载的配置，不重新读取 `.env`。直接 ID 的 CLI 恢复在参数检查后加载配置；进入写恢复之前仍完成平台/锁能力预检。新 REPL 的预检不创建会话文件，避免接受首次问题后才发现平台根本不支持。

### 共享的行式会话选择器

CLI 的无 ID `--resume` 与 REPL 的无 ID `/resume` 复用同一 bootstrap 选择器，数据来自 SessionStore.list，选择器本身不调用模型、不创建或修复文件、不申请候选写锁。仅在 stdin 和 stdout 都是 TTY 时可用；非 TTY 的 CLI 调用立即以 2 结束，提示使用 `--sessions` 或 `--resume <sessionId>`。非 TTY REPL 中的 `/resume`（含 --all）只报告用法、保留历史，不能消费下一行当选择答案。直接 ID 与 --continue 不要求 TTY。

默认 current 按当前 realpath 过滤；--all 仅改变初始视图。显示序号、lastActivityAt 的日期时间、首条 user 的安全摘要、logState、writerState 和不可恢复原因；all 视图另显示 cwd。排序、隐藏空会话与统计沿用下文列表规则。示意如下，时间是展示值，不改变磁盘 UTC 时间：

```text
恢复会话：/repo  [current]
1) 2026-10-28 10:32  "fix README..."      complete     available
2) 2026-10-28 09:10  "read src/core..."   interrupted  available
3) 2026-10-27 18:20  "..."               complete     busy（不可选）

输入编号并 Enter；a 切换 current/all；r 刷新；q 或空行取消：
```

- 输入正整数编号并 Enter，选择该次展示快照对应的会话，内部映射到完整 ID。非法、越界或不可选项只提示原因，继续选择，不发模型请求；空 Enter 不默认选择第一项。
- `a` 切换 current/all 并重新列举，`r` 刷新当前范围。每次明确刷新后重建编号映射；用户输入编号后不能先重排再把同一编号解释成另一个 ID。
- busy、其他 cwd、corrupt/unsupported 的目标不能选；诊断区不分配可恢复编号。unknown/changing 允许选择，但必须正式 openWrite 重验。本进程的当前会话显示“当前会话”，选择它仅关闭 picker、保留当前历史和锁，不重复打开。
- current 无条目时提示“当前目录没有可恢复会话”；all 无条目时提示“没有可恢复会话”。空视图仍允许 a/r/q，方便切范围或刷新，不列出虚构编号、不偷偷新建。只有 header-only 的会话默认隐藏，全局视图显式可见，同 cwd 时允许选择。
- CLI 中 q/空行取消或输入 EOF，未选择便退出 0；Ctrl+C 取消退出 130。REPL 中 q/空行/Ctrl+C 只关闭 picker，回原提示并保留会话/历史；输入 EOF 则结束整个 REPL，正常关闭后退出 0。任何存储/关闭故障仍优先退出 5。

v1 用行输入实现，暂不处理 Tab/Esc、方向键、搜索、分页或完整 transcript。选择器没有人工输入的 30 秒超时；每次 list/openWrite 的 I/O 仍受第 7 节期限约束。REPL 原会话在浏览和等待期间继续持锁；同一输入源只有一个消费者，picker 与普通问题循环不能各自创建竞争的 readline 消费者。picker 中输入 `/new` 等文字只是无效选择，必须先取消再执行 REPL 命令。

选择之后沿用“准备候选 → 关闭旧会话 → 替换历史”。列表观察只用于选择：文件消失、被占用或变坏仍由正式 openWrite 判定。启动 picker 的候选访问拒绝回到 picker，显示原因并刷新，用户可重选或取消；REPL picker 同样保留旧会话。直接 ID 恢复不自动进入 picker；访问失败按原错误规则报告。锁不可用、修复或其他 PersistenceError 不留在选择器重试，按存储故障收尾。

上述即时取消指等待选择输入时。list 刷新或 openWrite 进行中收到 Ctrl+C，只记录取消意图，等待已开始的 I/O settle 并关闭本次准备的候选后再退出选择，不提前解锁、不消费新问题；IO 超限或清理失败仍走第 7 节故障收尾。REPL 开始关闭旧会话前检查取消，取消可保留旧会话；一旦开始关闭旧会话，切换决定固定，不因新 Ctrl+C 撤销或复活旧句柄，先按既定顺序完成切换或报告关闭故障。EOF 则请求结束整个 REPL，仍等待这些资源收尾。

### 继续当前目录最近会话

`--continue` / `-c` 只读取当前 cwd 的候选，排除 header-only、损坏、不支持以及无法确认归属的文件。有效候选可为 complete/interrupted/torn_tail/missing_lf，按同一 lastActivityAt、createdAt、sessionId 排序选第一项；失败/取消但已合法结束的非空会话也可恢复。若排除了损坏/不支持条目，应报告诊断，不宣称扫描到的有效候选覆盖了无法解释的文件。

busy 不改变“最近”的认定，unknown/changing 也不能因探测不确定就被跳过。选定 ID 后必须 openWrite 重新取得锁、校验与必要修复；若此时 busy、消失、损坏或修复失败，报告对应错误并以 5 结束，不自动改选更旧会话。这样不会在用户不知情时换到另一段上下文。

没有候选时报告“当前目录没有可恢复会话”，以 SessionAccessError(not_found) / 退出码 5 结束，不进入 picker、不加载模型配置、不创建会话。直接 ID 恢复仍允许用户显式选择合法的 header-only 会话。最近会话排序依据日志活动时间而非 mtime；不引入“上次选择”元数据或后台索引。

### 列表的数据、状态和成本

列表是内存读模型，不写索引、元数据 sidecar 或正文；目录不存在返回空列表，不创建目录。逐文件读取 header，默认只扫描命中 cwd 的正文；`--all` 扫描全部候选。扫描固定初始字节范围，不能一次性把所有正文载入内存；元数据排序仍随条目数占用内存。无索引、无分页，成本随文件数和读取字节数增长，不承诺大量长会话时固定延迟。

| 字段 | 来源与展示规则 |
| --- | --- |
| sessionId、cwd、createdAt | 合法 header；时间不从 mtime 推断 |
| lastActivityAt、lastSeq | 最后一条有效记录，header-only 的时间回退 createdAt、seq 为 0 |
| turnCount、lastTurnOutcome | user 起点计数及最近 turn 的终止 outcome；缺 turn_end 为 interrupted，无 turn 时为空 |
| preview | 首条 user 的单行摘要，最多 80 个 Unicode 码点，移除终端控制字符；不展示工具原文 |
| writerState | busy / available / unknown；占用探测只代表当时状态 |
| logState | complete / interrupted / torn_tail / missing_lf / empty / corrupt / unsupported，按第 8 节映射 |
| observedAt、changing | 观察时间及前后 stat 是否变化；busy、changing 或未知占用均提示“仅已观察前缀” |
| resumability | yes / no / check_on_open，附原因；真正恢复必须重新取独占锁、校验，yes 也不保证稍后能打开 |

其他 cwd、busy、corrupt、unsupported 的条目标为 no；无法可靠判断或观察变化时为 check_on_open。writerState 与 logState 分开：闲置写者仍可 busy；活跃日志缺 turn_end 可以是 interrupted，不能据此宣称进程已崩溃；看到完整行也不代表写者已收到 fsync 确认。

合法条目按 lastActivityAt 降序、createdAt 降序、sessionId 字典序排序。`--sessions` 的文本输出显示完整 sessionId；picker 复用同一批条目但只显示序号，不把 sessionId 作为额外列。默认隐藏 header-only，报告隐藏数量；全局列表显示 empty。header 损坏而无法判定 cwd 的条目默认只计数，在全局诊断区显示文件位置与原因；损坏/不支持条目单列，不编造排序时间。单个坏文件不妨碍只读列出其他条目；目录读取等列表整体操作失败退出 5，成功展示含坏文件的诊断列表仍退出 0。

### 恢复、配置与切换

新会话 header.cwd 是启动目录的 realpath 绝对路径；恢复必须与当前规范化 cwd 完全相等。父子目录、不同 worktree、目录改名后的路径均不自动兼容；符号链接入口最终指向同一真实目录时允许。`read_file` 根目录使用该规范化 cwd，不根据日志切目录或加载另一项目凭证。

模型、端点、工具和 `.env` 使用当前启动环境；历史不控制当前配置。比较将进入上下文的最近成功 turn 的 runtimeProfile；无成功 turn 时回退最近 user。provider/model 不同时，在恢复完成后、首次新请求前向 stderr 提示旧值和当前值一次；纳入上下文的记录缺摘要则提示无法完整核对。提示不要求确认、不进入模型消息。相同 provider/model 不能解释为全部配置一致。

REPL 切换按“准备候选 → 关闭旧会话 → 替换会话与历史”执行。准备期间不接受新的模型输入，旧写者继续持锁；选择当前会话为无操作。busy、not_found、cwd_mismatch、corrupt、unsupported 等访问拒绝关闭候选资源后保留旧会话和历史，允许重试。候选修复、保存或关闭发生 PersistenceError，或锁服务不可用时，不再继续交互；关闭候选和旧会话后退出 5。旧会话关闭失败同样不能提交候选历史。

首次普通输入创建会话失败时不进入模型、不继续消费下一条问题，以 5 收尾退出；上述可重试规则仅适用于显式选择候选会话的访问拒绝，不把创建或保存故障当普通 turn 错误继续。

## 4. 调用链、模块与状态归属

```text
bootstrap/cli：参数分流、配置、cwd/时钟/UUID/锁/存储组装
  ├─ --sessions → SessionStore.list → 固定字节扫描和占用探测 → 列表
  ├─ --resume [ID] / --continue → 只读选择或定位 → 配置与写入预检 → openWrite
  ├─ --prompt   → displayTurn → runTurnStream（无事实 sink）
  └─ REPL：会话创建/打开/切换、输入和退出
       → core/runPersistentTurn：user → core facts → 唯一 turn_end
           → core/runTurnStream → streamAssembler → 顺序工具批次
           → TurnFactSink → SessionWriter.appendDurable
                                → adapters/session：映射、校验、写入、sync
       → turn_end(success) 确认 → CommittedTurnResult → REPL 历史提交
```

| 状态 | 所有者 | 是否落盘 |
| --- | --- | --- |
| 会话/turn 身份、当前 provider/model | bootstrap 生成并传入协调方；恢复身份来自合法 header | header 或 user 记录的对应字段 |
| 当前 turn 临时消息、模型次数、逐项工具事实 | core/runTurnStream 与批次执行器 | 仅完整校验后的消息和事实；不保存 SSE 片段 |
| 唯一 turn_end 的选择、事实等待和业务/存储异常分流 | core/runPersistentTurn；不依赖 Node、文件路径或 seq | 最终 outcome 与安全业务 error |
| 最近 20 组成功模型历史、输入、信号、会话切换 | bootstrap/repl | 磁盘不随内存窗口裁剪 |
| picker current/all、编号→完整 ID 快照、等待/准备状态 | bootstrap 的共享选择器；同一时刻独占输入 | 仅内存，不改变 SessionStore 格式或模型消息 |
| seq、timestamp、assistantId 映射、文件与锁句柄、最后确认游标 | 存储 adapter | seq/timestamp 与引用；句柄、Map、游标确认状态不另写事件 |
| 待创建、打开中、可写、故障、关闭中、已关闭 | 应用生命周期与存储句柄 | 仅内存；不引入 session_end |
| 工具 unknown/not_started、旧 turn interrupted | 扫描器依据事件推导 | 不写修复状态或伪造结果 |

保持四层 import 约束：core 仅依赖 core/contracts，adapter 仅依赖 adapters/contracts，bootstrap 组装双方。恢复投影和实时运行共用 core 的纯 `ToolResult → ToolMessage` 转换；adapter 返回已验证的业务数据，由 bootstrap 调用 core 投影，不能让 adapter 反向 import core。

### 既有代码必须调整的逻辑

| 位置 | 当前限制 | 本阶段目标与兼容影响 |
| --- | --- | --- |
| runTurnStream | 只有整轮成功的 appendedMessages/toolResults；最后一轮工具请求在交付前就停止 | 顺序交付完整 assistant 和工具事实并等待；合法末轮调用事实可先保存，再按 loop_limit 终止，绝不执行工具；保留成功返回视图 |
| executeToolBatch | 只返回整批数组，中途失败看不到前项；结果后检查取消可能丢掉已知结果 | 逐项开始/结果/异常交付；保存完整结果后才检查是否继续；原整批预检、顺序和 4/8 上限保持 |
| RegisteredTools.execute | 工具返回后取消检查可能丢掉已取得输出；内部异常统一包装 protocol_error | 合法完整输出先形成 ToolResult 并交付上层，后续取消不覆盖它；真正内部异常用稳定 ToolExecutionError 分类为 tool/tool_execution_failed |
| ToolResult / ToolMessage | 前者有 ok，后者没有；循环有重复转换 | 保留职责，落盘完整 ToolResult；共用纯转换，模型消息仍无 ok、seq 和配置摘要 |
| bootstrap/output.ts | displayTurn 同时调用 core 和渲染；reportError 无存储分类 | 让持久化协调路径复用文本渲染与换行收尾，不能绕开协调方；增加安全存储错误映射 |
| bootstrap/repl.ts | 历史从空开始；catch 所有 turn 错误后继续；clear 仅清数组；闲置 Ctrl+C 一律退出 | 接收恢复投影和 picker 输入状态；只提交协调方确认结果；存储故障停输入；new/clear 与 resume 管理资源，picker Ctrl+C 仅取消选择 |
| bootstrap/cli.ts | 两种模式提前加载同一配置，无列表/恢复分流 | 解析可选 ID、continue 和参数互斥；列表/picker 浏览不加载模型配置；帮助、TTY、配置和平台检查按顺序完成 |

取消边界只保证“已合法交付完整 ToolResult”不会被后续检查丢弃，不将文件系统已完成某次读取等同于业务结果已经交付。工具自身拒绝取消时仍是异常路径。保存等待放在工具业务 catch 之外，PersistenceError 原样穿透注册表和 core。

当前没有正式 yucli 会话文件，因而没有生产数据迁移任务。Message、ToolCall、ToolResult 的既有业务含义不变，新增持久化接口；`runTurnStream` 在现有参数之后增加可选执行上下文，不破坏普通单次和现有调用者。非流式兼容路径继续不持久化，共享工具逻辑调整后必须保持其原有协议、额度和取消结果。

## 5. JSONL v1 的数据结构

### 文件与公共字段

每个物理行是一个 JSON 对象，UTF-8 编码，以 LF 结束；字符串中的换行由 JSON 转义。文件没有数组外壳。第一行 header 必须存在且只出现一次：

| header 字段 | 约束 |
| --- | --- |
| type | 固定 session_meta |
| formatVersion | 固定整数 1；只放 header，其他版本拒绝 |
| sessionId | 稳定身份；与受管文件名一致 |
| createdAt | 创建时 UTC ISO 8601 时间；与文件名时间来自同一次取值 |
| cwd | 创建目录的 realpath 绝对路径 |

header 后每条记录都含 `seq`、`type`、`timestamp`、`turnId`、`payload`。seq 从 1 开始连续递增，为正安全整数；timestamp 使用 UTC ISO 8601 时间，不能决定事件顺序或要求单调递增。turnId 为非空字符串，新写入使用 UUID v4，同一会话不能复用旧 turnId。v1 没有 eventId、parentId、磁盘 assistantId 或幂等重试字段。

user 记录外层另有 runtimeProfile；新写入必填，只含非空白字符串 provider/model，当前 provider 为 opencode-go，model 是本 turn 实际值。读取允许整个对象缺失并标未知，对象存在时缺字段、额外字段或非法值均拒绝。不把摘要放入 payload/Message，不重复在其他记录保存，不记录 API key、endpoint、环境变量或工具配置。

| type | payload | 持久化与投影约束 |
| --- | --- | --- |
| message / user | `{role:"user",content:string}` | turn 唯一起点；内容保留原文，接受输入前已排除空白 |
| message / assistant | 现有完整 AssistantMessage | 保留 content/toolCalls；无调用时必须是非空白最终回答 |
| tool_start | `{callMessageSeq,toolCallId,name}` | 表示将交给注册表分派，含名称查找，不保证匹配或 execute 发生 |
| tool_result | `{callMessageSeq,toolCallId,name,ok:boolean,content:string}` | 正常 ToolResult，ok:false 仍可属于成功 turn；空内容合法 |
| tool_end | `{callMessageSeq,toolCallId,name,outcome,error}` | 没有正常结果的工具异常终止；当前 outcome 仅 failed/cancelled，不允许工具 timeout |
| turn_end | `{outcome,error?}` | outcome 为 success/failed/cancelled/timeout；决定整组历史资格 |

v1 message 记录只允许 user/assistant。当前 CLI 无自动 system 消息，模型 tool 消息由 tool_result 派生，不单独复制保存；system/context_reset 等新事件不在 v1。未知 type、非法字段结构或消息角色均拒绝，不能静默跳过。

assistant.toolCalls 保留 `{id,name,argumentsJson}`，同批 ID 唯一，argumentsJson 仍为字符串；按当前工具批次规则解析校验参数，不执行工具。未知工具名可合法记录，不要求它存在于当前注册表。配对键为会话内的 `(turnId, callMessageSeq, toolCallId)`；callMessageSeq 必须指向同 turn 更早、含同 ID/name 调用的 assistant。不同响应批次可复用 toolCallId。

### 安全错误与终止状态

error 保存安全对象 `{category,code,message,httpStatus?}`，不 stringify 原始 Error 或记录堆栈。category 为 model/tool/protocol/limit/cancellation/timeout/internal；code 为稳定机器码；message 为脱敏摘要；httpStatus 若存在须为 100–599 整数。不得保存认证头、原始模型错误体或未整理的工具异常。

| 来源 | outcome / category / code |
| --- | --- |
| RequestError network/http | failed / model / network 或 http |
| ResponseError，包括无工具的空白最终响应 | failed / model / invalid_response |
| 批次参数或协议非法 | failed / protocol / protocol_error |
| 第 8 次仍请求工具 | failed / limit / loop_limit |
| 工具不可恢复内部异常 | failed / tool / tool_execution_failed |
| 用户取消，已进入注册表或模型执行 | cancelled / cancellation / user_interrupt |
| tool_start 确认后、调用注册表前观察到取消 | cancelled / cancellation / cancelled_before_dispatch |
| 模型请求超时 | timeout / timeout / request_timeout |
| 未分类业务异常 | failed / internal / internal_error，使用固定安全摘要 |

上表完整配对用于 `turn_end`。`tool_end` 按工具上下文收窄，只允许 `failed/tool/tool_execution_failed`、`cancelled/cancellation/user_interrupt` 和 `cancelled/cancellation/cancelled_before_dispatch`。model、protocol、limit、internal 类错误只能作为 turn 终止原因，不能归到单项工具终止。

success 不带 error；其余 outcome 必须带匹配分类的 error。当前读写均拒绝 `tool_end(timeout)`，包括误用 `timeout/request_timeout` 或提前使用尚未定义的 `tool_timeout`；`turn_end(timeout)` 的模型请求超时仍合法。只有以后明确工具执行期限及其独立错误码/契约后才能增加工具 timeout；本阶段不新增，不因枚举存在就宣称能抢占 Node 文件调用。保存故障属于 PersistenceError，不通过这些业务错误伪装写回故障文件。

### 正常写入器产生的完整文件示例

以下 UUID、时间和目录均为示例；两项工具在同一 assistant 批次中顺序处理，第二项在进入注册表前取消：

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"9f7088b6-7ca6-4fd0-955a-68f05f9ca2ea","createdAt":"2026-10-27T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-27T02:00:01.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","runtimeProfile":{"provider":"opencode-go","model":"deepseek-v4-flash"},"payload":{"role":"user","content":"读取 a.md 和 b.md"}}
{"seq":2,"type":"message","timestamp":"2026-10-27T02:00:02.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"role":"assistant","toolCalls":[{"id":"call-a","name":"read_file","argumentsJson":"{\"path\":\"a.md\"}"},{"id":"call-b","name":"read_file","argumentsJson":"{\"path\":\"b.md\"}"}]}}
{"seq":3,"type":"tool_start","timestamp":"2026-10-27T02:00:03.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file"}}
{"seq":4,"type":"tool_result","timestamp":"2026-10-27T02:00:04.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file","ok":true,"content":"文件 A 的内容。"}}
{"seq":5,"type":"tool_start","timestamp":"2026-10-27T02:00:05.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"callMessageSeq":2,"toolCallId":"call-b","name":"read_file"}}
{"seq":6,"type":"tool_end","timestamp":"2026-10-27T02:00:06.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"callMessageSeq":2,"toolCallId":"call-b","name":"read_file","outcome":"cancelled","error":{"category":"cancellation","code":"cancelled_before_dispatch","message":"进入注册表前观察到取消，未分派该工具。"}}}
{"seq":7,"type":"turn_end","timestamp":"2026-10-27T02:00:07.000Z","turnId":"e2849bc9-ad37-4f1b-8fd3-f1b120502a55","payload":{"outcome":"cancelled","error":{"category":"cancellation","code":"cancelled_before_dispatch","message":"进入注册表前观察到取消，未分派该工具。"}}}
```

若第二项已经进入注册表，尚未交付正常结果时观察到用户取消，seq=6/7 的 code 都保留实际原因 user_interrupt，不可仅凭尚未进入具体 execute 就写 cancelled_before_dispatch。若文件只有 seq=1–5，则 call-a 的成功已知，call-b 是 unknown；不能由缺结果推断取消。已交付完整 ToolResult 后只保存 tool_result，再由 turn_end 表达整轮取消，不再补同一 call 的 tool_end。

普通成功文件的最小示例为：

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"7fb7939b-d44a-4ba6-a1ba-0d5177ec12db","createdAt":"2026-10-27T03:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-27T03:00:01.000Z","turnId":"1385d323-647a-4a77-93c6-302212d23b63","runtimeProfile":{"provider":"opencode-go","model":"deepseek-v4-flash"},"payload":{"role":"user","content":"你好"}}
{"seq":2,"type":"message","timestamp":"2026-10-27T03:00:02.000Z","turnId":"1385d323-647a-4a77-93c6-302212d23b63","payload":{"role":"assistant","content":"你好！"}}
{"seq":3,"type":"turn_end","timestamp":"2026-10-27T03:00:03.000Z","turnId":"1385d323-647a-4a77-93c6-302212d23b63","payload":{"outcome":"success"}}
```

### 合法组合与拒绝粒度

| 校验规则 | 违反时 |
| --- | --- |
| header 是首个物理行且唯一，版本受支持；每行符合对应 schema | 拒绝，不把后续 header 当另一个文件起点 |
| seq 从 1 连续递增；必填身份、时间、字段类型合法 | 重复/缺口/倒退拒绝，不重排或重编号 |
| 每个 turn 恰有一个 user 起点；同 turn 连续，开始新 turn 后不得返回旧 turn | 多余 user、跨 turn 交错或复用 turnId 拒绝 |
| 一个 turn 最多一个 turn_end，且为属于该 turn 的最后记录 | 重复终止或之后出现同 turn 记录拒绝；新 turn 合法 |
| assistant 的调用完整且批次校验合法；callMessageSeq 指向同 turn 更早的匹配 assistant | 非法参数、同批重复 ID、引用/名称不匹配均拒绝 |
| 每个 call 最多一个 tool_start；result/end 有前置 start，且终止记录最多一个 | 无 start、重复或 result/end 同时出现拒绝 |
| ok 为布尔值，content 为字符串，outcome/error 按对应约束取值 | 类型、枚举或分类不匹配拒绝；空工具 content 合法 |
| 工具按原批次顺序，前项 result 确认后才开始后项；tool_end 或悬空 start 后不再分派后项 | 重叠、越序或异常后继续调用拒绝 |
| 下一条 assistant 只在前批全有 tool_result 后出现；最终无调用 assistant 后无本 turn 业务消息 | 绕过未完成工具或最终回答后继续对话拒绝 |
| success 要求全部 call 都有 start/result，无 tool_end，最后业务消息为非空白且无调用的 assistant | 缺结果、只有调用或空白最终回答拒绝；ok:false 结果不阻止成功 |
| failed/cancelled/timeout 可以有未开始 call 或缺终止的 start | 按证据推导，不合成结果、不改成 success |
| 缺 turn_end 的有效前缀可保留；新 turn 开始后不补写旧 turn_end | 旧 turn 推导 interrupted；不是格式损坏 |

表中“拒绝”均指拒绝把**整个文件**恢复为可执行会话；不丢弃坏 turn 后继续投影其他 turn。只读列表可保留诊断，不把它当健康历史。错误至少含安全文件位置、物理行号/字节偏移、可解析的 seq/turnId/调用引用和原因，不输出原始正文。

没有结束事件是中断证据；已经写了 success 但缺结果是语义损坏，即使位于 EOF 也不能降为 interrupted。尾部未完成物理行仅按第 8 节处理，不能绕过此表。

### 恢复投影与状态

只有合法 `turn_end(success)` 的整组 user/assistant/tool_result 进入模型历史；tool_result 通过共用转换变为 ToolMessage，省略 ok、callMessageSeq、runtimeProfile 等存储字段。最近 20 个成功 turn 按文件顺序保留，整组裁剪；失败 turn 不占用成功窗口，也不与新问题拼接。failed/cancelled/timeout/interrupted 的 user 和中间事实仅留作诊断/展示来源。

工具状态先看合法终止事实：tool_result 区分 ok:true/false，tool_end 保留异常原因。尚未终止时，有有效 turn_end、无 start 且顺序规则能证明未分派，才为 not_started；缺 turn_end 或已有 start 而缺终止为 unknown。success 不允许这两种未完成状态。旧 turn interrupted 不覆盖其中已知的工具结果或异常；恢复不写 turn_end(interrupted) 或任何伪造 ToolResult。

## 6. core/storage 接口与保存屏障

### 有序事实及跨层接口

以下声明是待实现接口，正式代码应放入 contracts，并按项目规范补中文职责、字段与方法注释。现有 AssistantMessage、TextMessage、ToolResult、StreamTurnResult 的定义继续使用；类型声明不代替运行时校验。

```ts
type RuntimeProfile = { provider: string; model: string };
type SafeError = {
  category: "model" | "tool" | "protocol" | "limit" | "cancellation" | "timeout" | "internal";
  code: string;
  message: string;
  httpStatus?: number;
};
type FailureEnd = { outcome: "failed" | "cancelled" | "timeout"; error: SafeError };
type ToolEnd =
  | { outcome: "failed"; error: SafeError & { category: "tool"; code: "tool_execution_failed" } }
  | { outcome: "cancelled"; error: SafeError & { category: "cancellation"; code: "user_interrupt" | "cancelled_before_dispatch" } };
type TurnEnd = { outcome: "success"; error?: never } | FailureEnd;
type CallRef = { assistantId: string; toolCallId: string; name: string };

type CoreTurnFact = { turnId: string } & (
  | { type: "assistant"; assistantId: string; message: AssistantMessage }
  | { type: "tool_start"; call: CallRef }
  | { type: "tool_result"; call: CallRef; result: ToolResult }
  | { type: "tool_end"; call: CallRef; end: ToolEnd }
);
type TurnFact = CoreTurnFact | ({ turnId: string } & (
  | { type: "user"; message: TextMessage & { role: "user" }; runtimeProfile: RuntimeProfile }
  | { type: "turn_end"; end: TurnEnd }
));
interface TurnFactSink {
  record(fact: CoreTurnFact): Promise<void>;
}
interface TurnExecutionContext {
  turnId: string;
  facts: TurnFactSink;
}
interface SessionWriter {
  appendDurable(fact: TurnFact): Promise<{ confirmedSeq: number }>;
  close(): Promise<void>;
}

// 读取器已经完成格式、引用和成功条件校验，去掉磁盘 seq，保留业务输入。
type RecoveredItem =
  | { type: "user"; message: TextMessage & { role: "user" } }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResult };
type RecoveredTurn = {
  turnId: string;
  runtimeProfile?: RuntimeProfile;
  items: readonly RecoveredItem[];
};
type SessionMeta = {
  sessionId: string;
  createdAt: string;
  cwd: string;
};
type SessionSnapshot = {
  meta: SessionMeta;
  recentSuccessfulTurns: readonly RecoveredTurn[];
  lastUserProfile?: RuntimeProfile;
  interruptedTurnCount: number;
  repair: "none" | "truncate_tail" | "append_lf";
};
type SessionListEntry = SessionMeta & {
  lastActivityAt: string;
  lastSeq: number;
  turnCount: number;
  lastTurnOutcome: "success" | "failed" | "cancelled" | "timeout" | "interrupted" | null;
  preview: string;
  writerState: "busy" | "available" | "unknown";
  logState: "complete" | "interrupted" | "torn_tail" | "missing_lf" | "empty" | "corrupt" | "unsupported";
  observedAt: string;
  changing: boolean;
  resumability: "yes" | "no" | "check_on_open";
  reason?: string;
};
type SessionListDiagnostic = {
  sourceBasename: string;
  code: string;
  message: string;
  sessionId?: string;
  cwd?: string;
  line?: number;
  byteOffset?: number;
};
type SessionList = {
  entries: readonly SessionListEntry[];
  diagnostics: readonly SessionListDiagnostic[];
  hiddenEmptyCount: number;
  unattributedCount: number;
};
type OpenedSession = { writer: SessionWriter; snapshot: SessionSnapshot };
interface SessionStore {
  create(cwd: string): Promise<OpenedSession>;
  openWrite(input: { sessionId: string; cwd: string }): Promise<OpenedSession>;
  list(input: { cwd: string; all: boolean }): Promise<SessionList>;
  close(): Promise<void>;
}
type CommittedTurnResult = {
  status: "committed";
  turnId: string;
  result: StreamTurnResult;
};
```

SessionList 使用第 3 节字段；header 无法解析或统计不足的文件放 diagnostics，不伪造完整 SessionListEntry。diagnostics 的 code/message 使用安全原因，不附正文。create/openWrite 只在持锁、全文件校验和必要修复完成后返回，失败不能暴露半准备句柄；create 的 snapshot 为空。snapshot 只保留最多 20 个成功 turn 的业务数据及诊断计数，不把所有正文保存在列表或历史缓存里。core 纯投影函数把 RecoveredItem 的结果转成 ToolMessage，adapter 不调用它。

SessionStore 登记全部已打开和准备中的资源；单个 writer.close 关闭该会话，store.close 是幂等的进程级收尾，拒绝新操作并等待所有已登记资源结束后关闭。create/openWrite 失败或超时而尚未返回句柄时，资源仍归 store 管理，不能因 Promise 已拒绝就提前解锁，也不能遗漏清理；bootstrap 故障收尾必须等待 store.close，超出总收尾期限则结束进程。

bootstrap 把真实存储根、规范化 cwd、时钟、UUID 和锁适配器组装到存储实现；运行配置摘要由调用方显式交付 user fact。create/openWrite 的 cwd 已规范化，adapter 仍校验其与 header 的归属。列表和恢复的文件身份、seq 与扫描诊断不传进执行 core；confirmedSeq 只供存储/错误诊断使用，sink 桥接为 `async record(fact) { await writer.appendDurable(fact); }`。

runPersistentTurn 接收 writer、turnId、runtimeProfile、现有 client/registry/model/history/prompt/onText/signal。它是 user 与 turn_end 的唯一所有者；成功只返回 CommittedTurnResult，普通业务失败在保存对应 turn_end 后抛原稳定业务异常，存储失败抛原 PersistenceError。REPL 不直接消费持久化路径的裸 StreamTurnResult 提交历史。

core 为每个通过校验的 assistant 生成 turn 内递增 a1/a2，包括最终回答。adapter 维护 `(turnId, assistantId) → 已确认 assistant seq`，确认成功后才登记；工具事实检查本地引用、调用名/ID、结果字段，再转换为 callMessageSeq。未知引用、重复 assistantId、事件越序属于 PersistenceError(contract_violation)，写前拒绝并停止本次执行。turn_end 确认后清掉临时映射；恢复不继续旧执行，也不重建旧 a1/a2。

事实在交付时校验并快照，防止对象在等待期间被修改。同一 writer/turn 不并发 append 或 record，不 fire-and-forget；writer 内部串行化实际 I/O，错误后不复活。接口不接受模型/工具的取消 signal，避免已取消信号阻止必要收尾。

### 执行与确认顺序

| 当前动作 | 确认后才允许 |
| --- | --- |
| 新文件完整 header、文件和必要目录同步 | 写入首条 user |
| coordinator 保存 user | 第一次模型请求 |
| 模型流完整结束、assembler 与整批预检通过，保存 assistant | 工具批次开始；无调用则进入最终收尾 |
| 保存 tool_start | 再检查取消与额度；通过后才调用注册表，包括名称查找 |
| 保存 tool_result | 检查是否继续；下一项工具或下一次模型请求 |
| 保存 tool_end | 只允许 coordinator 保存非成功 turn_end |
| 保存最终 assistant | coordinator 检查并固定唯一 outcome，再保存 turn_end |
| 保存 turn_end(success) | 返回 CommittedTurnResult，REPL 提交完整消息组 |
| 保存非成功 turn_end | 报告原业务原因，REPL 可以接受下一次输入 |

“确认”统一指完整 JSON 与 LF 写入（处理短写），排空实际存在的应用缓冲，`FileHandle.sync()` 成功；直接使用 FileHandle 不虚构 flush API。新路径还需同步必要父目录，新增多级目录需确认各级目录项。不把排队、write 回调或普通 flush 称为耐久确认，也不承诺所有设备上的断电绝对不丢失。

tool_start 确认后若取消，core 明确不调用注册表，先 `await sink.record(tool_end(cancelled))`，code 为 cancelled_before_dispatch；确认后才抛业务取消，由 coordinator 保存唯一 turn_end(cancelled)。保存拒绝则传播 PersistenceError，不继续尝试普通终止写入。进入注册表后按实际原因处理；若完整 ToolResult 已交付，则先保存结果，再观察是否停止，不能追加同 call 的 tool_end。

模型流未完整合法结束、批次预检失败或空白最终响应时，不交付伪造 assistant。通过校验的最后一次模型工具请求可以保存 assistant 后写 turn_end(failed/loop_limit)，不分派任何工具。未知工具的正常路径为 assistant → start → result(ok:false)。

业务执行失败时先保留已交付事实，再由协调方映射 outcome。交付 turn_end 前检查并固定唯一终止原因；交付后等待期间的新取消不覆盖 outcome，不再写第二条终止事件。正常保存失败不在同一 writer 上重试：可能字节已经写出，只是确认丢失；重开时以实际文件证据判断。

流式文本仍即时输出，不因保存屏障缓冲整轮文本。临时业务成功、保存确认和历史提交是不同边界；终止保存失败时不得提交内存历史或报告“已保存”。

## 7. 文件、锁与关闭

### 布局与创建

```text
~/.yucli/
├── sessions/<timestamp>_<sessionId>.jsonl
├── locks/<sessionId>.lock
└── recovery/<sessionId>/<timestamp>_<uuid>.jsonl.bak
                         <timestamp>_<uuid>.repair.json
```

应用根来自 os.homedir()，测试显式注入隔离存储根，v1 不新增目录覆盖 CLI/env。sessions 为扁平目录；timestamp 是 createdAt 的 UTC ISO 字符串，将 `:` 和 `.` 替换为 `-`。恢复保留文件名、sessionId 和 createdAt，不把本地 sessionId 用作每次 HTTP 的 x-opencode-session 路由 UUID。

新目录为 0700，正文、锁、备份和清单为 0600，umask 可进一步收紧。已有受管路径须属于当前用户且没有组/其他用户权限，类型符合预期；写入不跟随受管目录和末端正文/锁的符号链接，打开后复核句柄身份。不 chmod home 或静默修改不合规路径。这些检查不是隔离所有父目录替换的 OS 沙箱；0600 也不等于加密。

首次普通输入依次创建必要目录、生成身份、取锁、检查无同 ID 正文，再用 wx 独占创建最终文件，写 header 并确认文件/目录同步，随后保存 user。ID/路径碰撞最多重新生成身份尝试 3 次，不覆盖已有产物；其他 I/O 错误直接失败。header 和 user 不是原子事务，可能留下空会话或无效半个 header；不伪造 user、不覆盖遗留文件。

只从受管 sessions 文件名定位，复核 header.sessionId 和文件名时间/身份。同一 ID 对应多个文件时拒绝写入，不按 mtime 选一个。resume 使用不创建文件的 r+，不能以 a+ 意外创建不存在的目标。

### 独占写者

锁适配器采用 **fs-ext@2.1.1** 的非阻塞 advisory flock：写者 exnb，只读占用探测 shnb。精确版本放 optionalDependencies，避免不支持的原生构建阻止无持久化模式安装；“可选”仅指包安装容错，持久化写入仍必须成功加载并通过预检。依赖只在持久化写入预检/占用探测路径按需加载；help/version、普通 --prompt 不因原生模块不可用而失败。只读列表无法加载或探测时 writerState=unknown，不据此授权执行。

锁定稳定的 locks/<sessionId>.lock，从可写会话打开到关闭一直持有，包括等待用户输入。文件操作结束、正文关闭后才释放锁；正常释放不删除锁文件，不按 PID、年龄、mtime 或心跳抢占。取锁后核对路径与所持 dev/ino 一致，运行期间发现替换为 ownership_lost；进程内登记禁止同会话多个可写句柄。

busy 立即拒绝，不阻塞等待。SIGSTOP 暂停的持有者仍占用；关闭描述符或进程死亡后内核释放，无需人工清理占位。不同会话互不阻塞。该保证只约束遵守协议的 yucli 写者，不隔离外部编辑器。禁止自动回退 mkdir、心跳回收或无锁写入。

只读列表仅对已有锁文件用只读句柄短暂探测，不创建/删除/写入锁文件；缺锁文件记 unknown。本进程已持有会话查句柄登记，避免用额外描述符干扰自己的锁。探测后真正恢复必须重新取 exnb、重新扫描，不复用探测结果或列表缓存。

### 保存失败、时间上限和进程退出

writer 在 write/sync、契约或所有权失败后进入故障，拒绝后续 append。报告安全的 operation/code、lastConfirmedSeq 和已知位置，不声称失败记录一定未写入；协调方停止新模型/工具请求和后续输入，取消可取消资源。不会为了记录存储错误递归写 tool_end/turn_end。

本规格新增固定的运行边界：create/openWrite/list/appendDurable/close 每次公开操作总等待上限为 **30,000 ms**，包括其内部 I/O 和同步；计时器/时钟由 bootstrap 注入测试，不新增用户配置。超限为 PersistenceError(io_timeout)，不是业务 turn timeout，不写成 request_timeout。长扫描/大备份超过时限也明确失败，不降级或跳过确认。

超时只表示不再等待业务完成，不表示底层 I/O 已取消。adapter 保留未决操作登记并观察最终结果，不开启后继写入，也不提前 close/unlock。进入存储故障后，bootstrap 启动**总计 5,000 ms** 的进程收尾期限：停止输入、发业务取消，等待已有 I/O 实际 settle，关闭正文/备份，再释放锁；收尾中仍保留原始故障分类。

5 秒内完成清理则正常返回退出码 5；期限到达仍有未决 I/O 或关闭无法完成时，由 CLI 组合根尽力输出安全错误并强制结束进程，退出码 5，让内核在进程消亡时释放资源。不得先显式解锁再保留仍可能写入的进程。这是对现有“只设置 exitCode 自然退出”的唯一存储挂起应急例外；core/adapter 不直接 process.exit。监督计时器不得 unref 到失效，未决 Promise 的后续拒绝也必须被观察。单元测试注入退出能力，CLI 子进程验证真实结束边界。

正常 close 首次调用即拒绝新 append，可重复等待同一关闭结果；等待已发出的操作完成、必要同步及正文关闭后再解锁。正常关闭的 30 秒到期后也进入上述 5 秒故障收尾；故障后收尾期限不因新一次 close 或信号重新计时。Ctrl+C 不能跳过已固定的终止保存，EOF 不丢弃已接受的 turn。保存/关闭故障优先于正常退出码 0/130。

## 8. 扫描、尾部修复与恢复续写

### 固定字节范围扫描

打开普通文件句柄，记录 dev/ino 和初始大小 S，仅解释 `[0,S)`，用字节 0x0A 划分物理行，严格 UTF-8 解码。偏移均为字节右开边界，不使用 JavaScript 字符串 length。每个完整行按 JSON → schema → 顺序/引用/生命周期校验，空行、未知事件和中间坏行不得跳过。header 无效或不完整直接拒绝，没有可恢复前缀。

内部 ScanResult 至少有 source dev/ino、observedSizeBytes、validEndBytes、lastLfEndBytes、lastSeq、tailKind、诊断位置及列表统计；损坏/不支持返回明确拒绝诊断，不能暴露为正常可恢复结果。validEndBytes 是所有合法记录前缀的末端，不是最后成功 turn 的末端；投影另按第 5 节筛选。

| EOF 情况 | tailKind 与只读边界 | 写恢复动作 |
| --- | --- | --- |
| 所有行合法且以 LF 结束 | none，validEndBytes=S | 不修改、不备份 |
| 最后无 LF，但该行完整且全套校验通过 | missing_lf，validEndBytes=S，计入 lastSeq | 备份后在 S 补一个 LF、sync、重验 |
| 最后无 LF，且确为可完成的 JSON/UTF-8 对象前缀 | incomplete，validEndBytes=P，P 为上一条有效 LF 后位置；残片 `[P,S)` | 备份后 truncate(P)、sync、重验 |
| 完整 JSON 的 schema/seq/引用/outcome 非法 | corrupt，整个文件拒绝 | 不截断、不补事件 |
| 明确非法 JSON/UTF-8、中间坏行或有 LF 的坏行 | corrupt，整个文件拒绝 | 不跳过、不拼接后续记录 |

实现独立 JSON 前缀识别器 complete/incomplete/invalid，跟踪对象/数组阶段、字符串/转义/Unicode、数字和字面量，并与严格 UTF-8 状态联合判断：只有存在追加字节使其成为一个合法 JSON 对象，才能判 incomplete。不能匹配 JSON.parse 的错误文字，不能只数括号。完整值仍由 JSON.parse 和业务校验解释；无法分类时拒绝。

例如 `{"seq":6,` 是可完成前缀；`{"seq":6,}` 明确非法；`{"seq":6}` 是完整 JSON 但 schema 非法。UTF-8 仅尾部缺后续字节也必须结合 JSON 所处位置判断，不能把本来在字符串外的非法字符误当可修复。只读扫描不改正文，即便可解释前缀中存在成功 turn，也不能将损坏文件交给模型继续执行。

### 列表 logState 映射

按以下优先级生成，writerState 独立计算：

| 证据 | logState |
| --- | --- |
| 不支持的 header.formatVersion | unsupported |
| JSON/schema/语义损坏 | corrupt |
| 有效前缀且 tailKind=incomplete | torn_tail |
| 合法最后记录且 tailKind=missing_lf | missing_lf |
| tailKind=none，仅 header，无 user | empty |
| tailKind=none，有任一 turn 缺 turn_end | interrupted |
| tailKind=none，有 user，所有 turn 均合法结束 | complete，含 failed/cancelled/timeout，不代表业务全成功 |

旧 interrupted turn 后的新 turn 成功时，logState 仍为 interrupted，lastTurnOutcome 可为 success。不补旧终止记录，不因这个状态阻止恢复有效成功历史。并发只读观察可能截在写入中，标 busy/changing；写恢复必须持独占锁重新扫描，不能沿用只读的 S/P。

### 写恢复的保全、修改和重验

1. 取得锁，r+ 打开正文；复核身份、权限、cwd、版本及 `[0,S)` 的全部记录，得到 S、P、lastSeq 和原件 SHA-256。校验失败只释放资源，不修改正文、不发模型请求。
2. 仅需要 truncate 或补 LF 时，在 recovery/<sessionId>/ 用同一新时间戳/UUID、wx 创建完整原件 `.jsonl.bak` 和 `.repair.json`。逐字节复制恰好 `[0,S)`，核对大小与摘要，不解析后重新序列化备份。
3. 备份与清单均 fsync，必要的 recovery 目录项也同步；全部确认前绝不修改正文。空间不足或备份失败保留原件，可留下诊断用未完成产物；没有完整清单与匹配摘要的备份不能用于自动还原。
4. 修改前再次核对正文 dev/ino、大小和 SHA-256，变化则停止。该复核依赖写者遵守锁协议，不承诺隔离任意外部修改。
5. incomplete 截到 P；missing_lf 只在 S 补 LF。对同一正文句柄 fsync，重新读取并校验连续、换行完整的实际文件；不改旧 JSON、不补旧 turn_end。
6. 以上全部成功后，openWrite 才返回可写句柄与快照；seq 从有效 lastSeq+1，新 turnId 重新生成。header-only 从 seq=1 开始。

修复清单字段为 version=1、sessionId、sourceBasename、createdAt、action（truncate_tail/append_lf）、originalSizeBytes、validEndBytes、lastSeq、sourceSha256。清单本身不是成功标记；恢复时仍校验实际文件，不凭清单自动回滚。崩溃可能发生在任意步骤，修复不宣称整文件原子事务；下次若正文已经完整合法，不重复备份。

备份额外占约一个原文件大小，完整保留消息及残片的敏感内容；目录/文件 0700/0600，**不加密、不自动清理**。truncate/补 LF/sync/重验失败为 repair_failed，底层超时仍保留 io_timeout 及 operation=repair；不接受新 user，不继续当前 REPL。待所有已发出的操作结束后关闭资源、释放锁；仍未决则按第 7 节进程期限结束，不能为重试提前解锁。

2026-10-29 T5 验收澄清（用户确认）：修改前失败保证本次操作不改变正文；truncate/补 LF 已生效后，后续 sync/重验失败保留实际字节及完整备份，返回 repair_failed，不交付 writer、不回滚、不重试旧边界。不得把 B07 的“修改前保持原字节”扩张成 B08 的修改后原子回滚保证。T5 不实现本节引用的 30 秒/5 秒监督，该部分仍归 T7。

header-only、创建失败产物、稳定锁文件及备份会累积。手动删除须在所有相关写者退出后离线进行：正文与 recovery 备份分别决定是否删除，锁文件可保留；不得在可能有持有者或并发打开者时 unlink 锁。未来删除/归档须另行设计锁、备份、目录同步和失败恢复，本阶段不实现。

## 9. 错误、退出码与恢复能力

新增 SessionAccessError（访问拒绝）和 PersistenceError（保存/修复/所有权/关闭故障），字段为安全 operation/code/message，可带 lastConfirmedSeq、行/字节位置；不回显未经整理的原始异常或正文。5 表示会话操作未完成，不等于一定丢失数据。

| 分类/code | 启动或当前进程行为 |
| --- | --- |
| SessionAccessError：session_busy、not_found、cwd_mismatch、unsupported、corrupt、invalid_identity、permission_denied | 直接 ID/continue 启动恢复退出 5；picker 候选访问拒绝则释放候选并回选择器；REPL 保留健康旧会话并允许重试 |
| SessionAccessError：platform_unsupported | 创建/恢复预检无持久化副作用地退出 5 |
| SessionAccessError：lock_unavailable | 与 busy 区分；启动退出 5，REPL 停止新的持久化执行并关闭退出，不降级 |
| PersistenceError：write_failed、sync_failed、repair_failed、ownership_lost、close_failed、contract_violation、io_timeout | 停止新执行/输入，不递归写终止；关闭或按应急期限结束，退出 5 |
| 模型/工具普通失败、取消、超时 | 非成功 turn_end 确认后沿用阶段 03：REPL 继续，单次模式返回 4 |
| 参数/配置失败 | 保持 2/3，不创建会话或发请求 |
| 正常退出/闲置取消 | 资源关闭成功时为 0/130；保存或关闭故障优先为 5 |
| CLI picker 取消、空视图、或非 TTY 调用 | q/空行/EOF 取消为 0，Ctrl+C 为 130；空视图等待显式选择范围/刷新/取消；非 TTY 为用法错误 2 |
| --continue 无候选或选定候选后访问失败 | 退出 5，不改选旧会话或新建；REPL picker 的访问拒绝可回到选择器 |

执行中保存失败即使同时观察到取消，也保留原 PersistenceError，不能改写为 AbortError、protocol_error 或 tool_result(ok:false)。访问阶段权限不合规为访问拒绝；已持有 writer 后 I/O/所有权变化是存储故障，不能被 REPL 的宽泛 catch 吞掉。

## 10. 设计选择与参考依据

| 决策 | 本阶段采用 | 备选及未采用原因 |
| --- | --- | --- |
| 历史真相与读模型 | 单文件追加 JSONL；严格校验后投影完整成功 turn | JSON 消息数组易覆盖且不表达执行边界；SQLite/索引扩大查询、迁移与依赖范围 |
| 工具数据 | assistant 内保存调用，独立 result 保留 ok，start/end 表达生命周期 | 单存 ToolMessage 丢 ok；再存 tool_call/tool message 会重复事实 |
| 保存确认 | 每个业务屏障完整写入和文件同步，创建同步目录 | 后台接受/普通 flush 边界较弱；合并同步优化待测量，不能越过副作用屏障 |
| 写者 | 稳定 sidecar 的非阻塞内核锁，fs-ext@2.1.1 | mkdir 崩溃后需人工清理；心跳可能抢占暂停进程，不满足自动接管语义 |
| 恢复 | 同 cwd、严格拒绝整个损坏文件、仅修复可证明未完成尾部 | 跳过坏行会伪造合法历史；自动补结果或续跑会误判外部执行 |
| 模型历史与新建 | 最近 20 个完整成功 turn；/new 新建会话，/clear 保留同义别名 | 失败 user 留在模型可能与新问题一起回答；原文件 context_reset 增加格式机制 |
| 恢复入口 | 无 ID 默认共享 picker 按编号选择；--continue 当前 cwd 最近；完整 ID 直达；全局视图只预览其他 cwd | 让用户只记完整 ID 才能恢复会增加负担；完整 TUI、名称匹配和跨 cwd 运行扩大本阶段范围 |
| 配置与模式 | 当前启动配置，user 外层仅 provider/model；REPL 保存、单次不保存 | 历史配置可能带凭证/过期策略；指纹及所有脚本自动保存扩大 v1 范围 |
| 资源与清理 | 无记录字节硬上限、无索引分页、完整备份保留，操作有明确期限 | 上限需写读共同设计；自动删除与修复恢复需要独立所有权协议 |

借鉴 Pi 的可读日志与惰性创建、DSH 的存储契约和所有权、Codex 的写者与保存屏障分工、ZCode 的核心端口及恢复投影。没有复制参考项目的树 UI、后台队列、SQLite 或宽容跳行；它们的同步 append/flush 也不作为本规格 fsync 保证的证据。参考源码和快照依据保留在调研报告，不在规格重复整份调研。

本次入口对照了本地 [Codex CLI 的恢复分流](../../../references/codex/codex-rs/cli/src/main.rs)、[Codex 会话选择器](../../../references/codex/codex-rs/tui/src/resume_picker.rs)、[Pi 的启动参数](../../../references/pi/packages/coding-agent/src/cli/args.ts)和 [Pi 的交互选择器](../../../references/pi/packages/coding-agent/src/modes/interactive/components/session-selector.ts)。采用其“默认选择 / 最近继续 / 直接定位”分工，以及 current/all 的可见范围；具体按键、空列表和 cwd 执行边界以本规格为准，不推定其他项目的全部行为相同。

## 11. 实现任务清单

按依赖顺序交付，每项完成必须在“实际结果”写明代码、验证和限制。不得在执行前把所有任务勾成完成。

- [x] **T1 规格与契约**：完成规格评审和 ADR-006 接受；新增 docs/contracts/session-store.md，固定格式、接口、扫描结果、错误与生命周期；CLI/REPL/tool-execution 契约登记阶段 04 draft 扩展，包括可选 ID、continue、共享 picker、new/clear 和输入/取消所有权；更新 architecture、文档入口和 legacy-paths 的实际影响。
- [x] **T2 依赖与锁**：以 optionalDependencies 固定 fs-ext@2.1.1，在目标 Node/平台完成实际安装、构建授权、本机工具链和按需加载验证；实现稳定锁、占用探测和进程内登记，重复应用级双进程互斥、暂停、关闭与 SIGKILL 验证，禁止静默回退。托管 CI 的矩阵与流水线验证移交 T9。
- [x] **T3 格式与扫描**：新增 contracts/session.ts 业务类型/错误、adapter JSONL schema/语义校验与字节扫描、JSON/UTF-8 前缀识别器；完整覆盖合法组合表和诊断位置。B06 的只读分类/原件不变已验证，备份修复与 sync 重验仍归 T5。
- [x] **T4 文件与 writer**：实现目录/身份/权限、wx 创建、短写与 sync、seq/assistantId 映射、失败状态及 close；新增可控 I/O/时钟注入，不引入生产假模型客户端。目标 Node 下新增 69 项测试，T3 双扫描入口验证实际字节；创建资源收尾已覆盖，恢复/修复、core 屏障和退出监督仍属 T5–T7。
- [x] **T5 恢复与修复（存储范围）**：持锁重新定位/扫描、完整备份及清单同步、修改前复核、truncate/补 LF/重验、成功 turn 业务快照、已有文件续写与资源收尾；失败不发模型请求、不自动重放。成功 turn 的纯模型投影不在本任务，已正式移至 T6。新增 102 项测试，目标 Node 下全部 692 项通过；实现已获用户授权独立提交。
- [x] **T6 core 交付与纯模型投影**：调整 runTurnStream、executeToolBatch、RegisteredTools 的逐项事实与结果取消边界；新增纯 ToolResult→ToolMessage 转换与 ToolExecutionError；新增 sessionHistory/恢复历史投影，把 T5 的 RecoveredItem/RecoveredTurn 业务快照转换为模型消息，保持整批预检、顺序、额度和兼容路径。新增 57 项、2 个测试文件，目标环境全部 17 文件/749 项及 typecheck/lint/build 通过；已获用户授权独立提交，不含 T7/T8。
- [ ] **T7 协调与退出监督**：新增 runPersistentTurn，唯一 user/turn_end、保存确认提交凭证、PersistenceError 穿透；实现 30 秒操作等待、5 秒故障收尾和组合根应急退出。
- [ ] **T8 CLI/REPL**：分开新建/单次/列表/选择恢复/直接恢复/continue；实现共用行式 picker、TTY 检查、编号快照和 current/all/刷新/取消、new/clear 别名、最近候选选择及无会话行为；接入列表状态、配置提示和安全退出；故障后停止消费管道中的后续问题。
- [ ] **T9 集成验收**：运行第 12 节矩阵及项目类型、Lint、构建和全套测试；源码/构建产物 CLI、锁与故障子进程均覆盖；完成目标环境的人工重启/恢复检查。
- [ ] **T10 文档与完成审查**：按实测结果更新本文件、README、architecture、契约与依赖说明；报告保留限制和未验证环境，审核中文注释、Git diff 和阶段分支。只有验证完成才转 verified，用户审查后再转 done/申请集成。

规划新增模块为 contracts/session.ts、core/runPersistentTurn.ts、core/sessionHistory.ts、core/toolMessage.ts，以及 adapters/session 下的 store/writer/scanner/repair/lock/prefix 组件；具体文件拆分可随实现规模合并，但职责、依赖方向和验收不能省略。bootstrap 可新增共享 sessionPicker 与小型会话生命周期/退出监督模块，不把交互放入存储 adapter 或业务过程堆入参数解析器，不新建事件总线、插件平台或未使用抽象。

## 12. 验收矩阵与验证计划

以下均为待实现的真实运行时验收；类型声明通过不能替代。延迟与竞态测试使用可控 Promise、IPC 和时钟，不靠固定 sleep 猜时序。SSE 集成使用真实 adapter + 本地 HTTP 服务，落盘使用临时目录；生产 home 不参与测试。

### 成功路径与用户模式

| 编号 | 场景 | 必须观察到 |
| --- | --- | --- |
| A01 | 帮助/版本/参数失败/空 REPL/空行/help 后退出/普通 --prompt | 不创建新会话、锁或 recovery；--prompt 保留原协议和退出结果 |
| A02 | REPL 两次普通输入、正常退出 | 首次创建一个合法文件，后续追加同文件；每轮一个 user/turn_end，完整换行和 profile；关闭后可重新取锁 |
| A03 | 同毫秒创建、注入 ID/路径碰撞 | UUID 区分；最多 3 次身份重试，不覆盖已有文件；其他创建失败无模型请求 |
| A04 | 同 cwd 新进程恢复，随后新输入 | 请求包含最近成功历史及新问题；seq 连续、turnId 新建、文件身份不变；无旧工具执行 |
| A05 | 工具往返、ok:false、空文件、未知工具 | 正常保存完整 ok/content，派生模型 tool 消息无 ok/seq/profile；未知工具有 start 和 ok:false；最终回答合法时可成功 |
| A06 | 21 个成功 turn，中间穿插失败/中断 | 模型仅最近 20 个成功完整组；磁盘原文不裁剪；失败 user 不进入新请求 |
| A07 | /new 与 /clear 后新输入、显式再打开旧会话 | 两个命令同义，新 ID/文件、下一请求无旧上下文；旧文件可恢复；关闭失败不进入新会话 |
| A08 | 当前/其他/父子 cwd、不同 worktree、目录改名、符号链接入口 | 默认列表过滤；global 其他目录仅预览；恢复严格按 realpath 相等，模型配置不从日志加载 |
| A09 | provider/model 变化或缺摘要 | 一次安全提示且用当前配置；新 user 外层摘要正确，消息类型不扩展；不宣称核对其他配置 |
| A10 | 正常、空、损坏、busy/unknown/changing 列表与并列时间 | 字段、隐藏计数、排序与状态独立；只读不改文件、不建目录；缓存观察不授予写权限 |

### 格式、损坏与恢复算法

| 编号 | 场景 | 必须观察到 |
| --- | --- | --- |
| B01 | 第 5 节合法组合表的每条正/反例 | 语义损坏拒绝整个文件，诊断含精确位置；不跳行、不静默纠正 |
| B02 | 多批复用调用 ID、错误引用/名称/未来 seq、重复 start/result/end | 按 callMessageSeq 配对；非法引用和重复终止拒绝 |
| B03 | 空白最终回答、success 缺结果或带 error、非成功缺 error | 拒绝非法文件；运行期保留现有 invalid_response 行为，不保存假最终 assistant |
| B04 | user-only、start-only、一个结果完整/后项未完、旧中断后新成功 | 正确区分已知/not_started/unknown/interrupted；映射 logState；不补旧结束或重跑 |
| B05 | UTF-8 拆分、字符串/转义/Unicode/数字/字面量的可完成与非法尾部 | 严格区分 complete/incomplete/invalid；字节边界正确；有 LF 的坏行和完整非法事件拒绝 |
| B06 | 合法记录缺 LF，及未完成无 LF 尾行 | 只读原件不变；持锁备份后分别补 LF/截 P，sync 重验后 seq 正确 |
| B07 | 备份不足空间、复制/清单/sync 失败、源身份或摘要变化 | 修改前失败保持正文原字节；未完成备份保留诊断；不开始新执行 |
| B08 | truncate/补 LF/sync/重验各步失败与进程中断后二次打开 | repair_failed/超时停止执行；按实际字节再校验，不盲目回滚或重复应用旧边界 |
| B09 | 字节数、SHA-256、原件与备份匹配 | 使用实际 UTF-8 字节断言；备份包含完整有效前缀和残片，修复不重写旧 JSON |

### 保存屏障、取消与错误传播

| 编号 | 注入点 | 必须观察到 |
| --- | --- | --- |
| C01 | header/user/assistant/start/result/end 的 appendDurable 延迟 | 依赖它的模型请求、注册表分派、后项工具或 turn 终止都不能越过屏障 |
| C02 | 每个写入/确认 Promise 拒绝或确认丢失 | 原 PersistenceError 穿透，无 protocol_error/ok:false/取消改写；不递归写终止、不重试同 seq、不提交历史 |
| C03 | tool_start 确认前后取消 | 等待确认再判断；未调用注册表则 end 的 code=cancelled_before_dispatch，end 确认后才由 coordinator 结束 turn |
| C04 | 注册表进入后取消、结果完整交付后取消 | 前者保留实际取消原因；后者先保存 ToolResult，之后不开始后项；同 call 终止不重复 |
| C05 | 第一工具完成后第二取消、工具后模型失败、最后模型请求工具 | 已知事实保留，整轮不提交失败上下文；末轮调用不执行；工具内部异常与协议错误分类不同 |
| C06 | turn_end(success) 延迟/失败，期间再次 Ctrl+C | 确认前 REPL 历史不变；固定 outcome 不改写或重复；失败退出 5，不能报告已保存 |
| C07 | 取消/模型超时的终止保存 | 收尾不复用已 aborted signal；确认后才允许新输入，保存失败停止 REPL |

### 锁、权限、关闭与 CLI 集成

| 编号 | 场景 | 必须观察到 |
| --- | --- | --- |
| D01 | 双进程同会话、不同会话、同进程重复句柄、闲置持有者 | 同会话至多一写者；busy 立即拒绝，启动 5，REPL 候选冲突保留原历史；不同会话独立 |
| D02 | SIGSTOP、close、SIGKILL 和后继恢复 | 暂停不抢占；关闭/死亡后可接管；稳定锁文件保留、不被年龄清理 |
| D03 | 原生库加载失败、未支持平台、锁 inode 替换 | 区分 lock_unavailable/platform_unsupported/ownership_lost；无锁降级禁止；help/单次仍可运行 |
| D04 | 目录/正文/锁的符号链接、错误类型/权限/所有者、同 ID 多文件 | 创建/恢复拒绝，不覆盖/自动 chmod；新目录/文件权限与身份正确 |
| D05 | close 重入、EOF/exit/闲置取消、切换旧 close 失败 | 正确关句柄和锁，无多余 session_end；0/130/5 优先级明确，候选不泄漏 |
| D06 | 操作永不 settle、迟于 30 秒 settle、故障收尾继续挂起 | 先进入 io_timeout/fault；I/O 未结束不显式解锁；5 秒后由组合根结束，退出 5，后继可重开校验 |
| D07 | 输入管道预送多个问题，第一个触发保存失败 | 不再消费为后续 turn，不再发模型请求；安全 stderr 与退出 5，源码和构建产物一致 |
| D08 | 新 CLI 参数互斥、--all 误用、非法 ID、列表无密钥 | 参数错误优先且无副作用；列表独立于模型配置；恢复失败不偷偷新建 |

### 恢复入口与选择器

| 编号 | 场景 | 必须观察到 |
| --- | --- | --- |
| E01 | --resume/-r 无 ID、有 ID，--continue/-c，所有模式组合 | 无 ID 进入 picker，有 ID 直达，continue 不弹 picker；模式两两互斥，空 ID/多余参数/continue 带参为 2 |
| E02 | --all 与 sessions、无 ID resume、直接 ID、continue、单独使用 | 仅前两种合法；REPL /resume --all 初始为全局，非法组合不加载模型配置或创建文件 |
| E03 | CLI/REPL picker 默认、切换 a、刷新 r | 相同字段/排序与组件逻辑，复用 SessionStore.list；只读、不申请候选写锁；编号只在显式刷新/切范围后重建 |
| E04 | 选择编号前后列表顺序变化、文件被占用/删除/损坏 | 编号仍映射原展示 ID，openWrite 必须重验；访问拒绝显示并刷新，不误恢复另一个 ID；REPL 原历史和锁保持 |
| E05 | busy/其他 cwd/unknown/changing/当前会话 | 前两者不可选且说明原因；未知或变化需正式打开判断；当前会话仅退出 picker，不重复打开；全局不切 cwd |
| E06 | current 无记录、global 无记录、只有空会话、取消 | 提示无会话，仍能 a/r/q，无虚构默认选项或偷偷新建；global 显式空会话仅同 cwd 可选 |
| E07 | 非整数/越界/命令文字、空 Enter、q | 无效选择不进模型；空 Enter/q 取消；启动取消为 0，REPL 返回原提示且历史不变 |
| E08 | 等待选择输入时 Ctrl+C/EOF 与原 REPL 闲置 Ctrl+C | 启动 Ctrl+C=130/EOF=0；REPL picker Ctrl+C 只取消选择，EOF 关闭整个 REPL；原普通提示 Ctrl+C 仍为 130 |
| E09 | stdin 或 stdout 非 TTY 的无 ID resume；管道中的 /resume 后有下一条问题 | CLI 在读取/配置/副作用前返回 2 并提示替代命令；REPL 不拿下一行当选择答案；直接 ID/continue 仍可用于非 TTY |
| E10 | continue 的时间并列、旧失败/中断/坏尾行、空/损坏/其他 cwd | 按已定义有效非空候选和稳定排序选最近；排除项有诊断；无候选为 not_found/5，不加载模型配置或新建 |
| E11 | continue 最近候选 busy、unknown/changing，及选后发生竞争 | 不因 busy 或未知占用改选更旧目标；正式 openWrite 失败即对应错误/5，无循环回退 |
| E12 | 启动 picker 无密钥浏览/取消、选后配置失败；REPL 切换时配置变化、I/O 期取消或挂起 | 启动浏览不依赖密钥，选后配置错误=3 且无写锁/修复；REPL 不重读 .env；人工输入无超时，I/O 有期限；准备期取消等清理，旧 close 开始后不撤销切换；单一输入消费者 |

实现时至少运行下列项目命令，保留每次结果及对应环境；本轮撰写规格不把它们记为通过：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

pnpm test 已包含重新构建，防止 CLI 测试使用旧 dist；新测试纳入相同入口。另在目标平台用源码与构建产物做实际 CLI 重启/恢复、取消、锁冲突和尾部修复冒烟。持久化主线不要求额外真实模型费用：本地真实 adapter/SSE 集成是必需验收；如模型 adapter 行为发生额外变化，或 mock 与实际结果有差异，再安排针对性真实联调并单独记录。

fs-ext 原生依赖的构建前提须在实现时记录，包括 Node 版本、macOS 架构及所需构建工具；CI 不支持目标环境时不能简单 skip 后宣称持久化全通过，应报告对应缺口。进程崩溃测试不等于断电测试，不证明硬件级耐久性。

## 13. 实际结果与下一步

### 已完成

- 2026-10-29：阶段 04 规格完成评审，状态转为 `designed`；ADR-006 转为 `accepted`。
- 2026-10-29：完成 T1 文档收口，新增会话存储契约，并在 CLI、REPL、工具执行契约中登记阶段 04 的 `draft` 扩展；同步架构、文档入口和非主流程清单。

- 会话持久化调研与逐项讨论收口；规格首稿、accepted ADR 和实现/验收任务已整理。
- T1 时的既有代码阅读确认了中途交付、结果取消、错误分类和 REPL 继续行为的调整范围；当时未修改生产源码和依赖，受影响契约登记为阶段 04 `draft`。T2 的实际变更见下节。
- 调研期间 fs-ext@2.1.1 已在隔离目录、macOS arm64 + Node 24.14.0 验证安装、双进程互斥、异步 exnb、只读 shnb、暂停保护、描述符关闭/SIGKILL 释放及目录同步调用；证据范围见调研报告 9.5。项目内安装与锁应用级测试现由 T2 完成；托管 CI 及完整持久化应用集成仍待 T9。

### 本轮验证与未完成项

- 以下 T1 说明保留为历史记录；本轮 T2 实现及验证单列在后，不声称阶段 04 已全部实现。

T1 文档检查覆盖阶段规格、ADR、契约、架构和文档入口：本地链接均可解析，阶段状态与契约状态一致，新增 JSONL/事实交付示例与规格中的记录类型、错误和恢复边界一致。

规格中的候选类型此前已提取至临时 .mts，并使用项目 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 等选项执行 `tsc --noEmit`，校验通过；这只验证声明兼容性，不等于已实现存储接口或通过项目全套检查。T1 当时未运行 pnpm typecheck/lint/test 或真实模型请求，未执行尚未实现的运行时验收。T1 的声明检查不能替代保存屏障、取消竞态或错误穿透测试；T2 新增检查见后文。

2026-10-28 的入口修订新增 E01–E12，当前共 46 个待实现验收场景；格式、存储接口和 30 秒/5 秒期限不变。T1 复核了取消、非 TTY、无会话边界、JSONL 示例、类型声明、命令互斥和本地链接；没有重跑未变化的类型声明校验、业务测试或真实模型请求。调研报告中的其他工作区修改不属于本次 T1 文档收口。

### T2 依赖与锁：实际结果（2026-10-29）

本轮只执行 T2，T3–T10 未勾选、未实现；规格保持 `implementing`，会话存储契约保持 `draft`。没有实现 JSONL writer、扫描/修复、SessionStore、picker、coordinator 或 core 事实交付，没有修改 bootstrap/cli、bootstrap/repl 或普通 --prompt/help 行为。

#### 代码与边界

- package.json 的 optionalDependencies 精确固定 `fs-ext: 2.1.1`，pnpm-lock.yaml 同步，并锁定其传递依赖 nan 2.30.0。新增 pnpm-workspace.yaml 的 onlyBuiltDependencies，仅允许 fs-ext 原生构建；不全局放开安装脚本。
- [session-lock.ts](../../src/contracts/session-lock.ts) 仅提供 T2 的 SessionLock、LockWriterState 及锁所需的最小 SessionAccessError/PersistenceError 分类，不提前定义 T3 的日志格式/事实/扫描类型。后续错误分类可在 T3 扩展，不能将其另造为不同的同名异常而破坏 instanceof。
- [lockPlatform.ts](../../src/adapters/session/lockPlatform.ts) 在任何 mkdir/open-create 前校验 macOS arm64、精确 Node 24.14.0，按需加载并验证 native，再只读解析最近已存在祖先及 `/sbin/mount` 的最长路径段匹配，要求显式 local。平台/挂载无法确认是 platform_unsupported；native 缺失、加载或导出失败是 lock_unavailable，不切换锁方案。构造/import 不加载 native。
- [SessionLockAdapter.ts](../../src/adapters/session/SessionLockAdapter.ts) 暴露 preflight/acquire/probe；默认根 ~/.yucli，测试注入临时根。仅预检通过后创建 0700 根/locks 容器和 0600 的 locks/<sessionId>.lock；拒绝受管目录/末端锁符号链接、非普通文件、非私有权限/所有者。不自动 chmod，不截断既有锁文件。
- 写者为 exnb，读探测为已有文件的 O_RDONLY + shnb；缺路径、无法加载或无法可靠探测返回 unknown，不产生新目录/文件。本进程持有或正在申请的 sessionId 直接返回 busy，不为自己的锁打开额外探测描述符。available 不是写入许可，真正写入必须重新 acquire。
- 取锁后比较路径 lstat、描述符 fstat 的 dev/ino，并复核受管目录身份；运行中由 assertOwnership 再查，替换/删除/权限变化是 ownership_lost，故障保持，不因路径被换回而复活。失败只关闭旧描述符，不 unlink 被替换的新文件。
- 进程内登记在首次 await 前占位，跨 adapter 实例禁止同会话重复申请（同 ID 即使使用不同注入根也保守拒绝）。锁句柄隐藏 fd；release 幂等，等待已发出的检查 settle 后关闭描述符，由内核释放 flock，确认关闭后才撤销登记。申请失败也等 native 调用实际结束后清理；关闭失败报告 close_failed 并不假装释放成功。
- 不写 PID/mtime/年龄/心跳，不清理稳定锁文件，不用 mkdir 占位或无锁 fallback。容器目录的 mkdir 只是为真正的 flock 文件提供位置，不作为互斥机制。当前不认识正文 I/O：未来 writer 必须先等其 I/O settle/关闭正文，最后 release。

#### 目标环境安装、构建与按需加载

实际机器 Darwin arm64，本轮所有安装、构建和测试均以 Node 24.14.0 / pnpm 10.33.2 运行（Node ABI 137），未使用全局 Node 26 构建 CLI/native。磁盘测试路径位于本地 APFS，真实 ~/.yucli 未参与测试。

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm add --save-optional --save-exact fs-ext@2.1.1'
# 添加 onlyBuiltDependencies 后在目标 Node 下执行：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm rebuild fs-ext'
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm install --frozen-lockfile'
```

- 初次 add 时 pnpm 安全策略提示 Ignored build scripts，未将包存在误报为可用。加入只授权 fs-ext 的构建配置后实际执行 node-gyp configure build，gyp info ok；使用 createRequire 加载，版本为 2.1.1，flock 导出为 function。`file fs_ext.node` 确认为 Mach-O 64-bit bundle arm64。
- 另将 package.json、lockfile、构建授权配置复制到隔离临时目录，并使用独立空 pnpm store 执行 `pnpm --dir <temp> --store-dir <temp>/store install --frozen-lockfile --prod`，再次实际编译成功并通过目标 Node 加载，未依赖已有 node_modules/native 产物。仅复制依赖文件，不复制 .env 或会话。
- 实测构建前提：Xcode Command Line Tools（/Library/Developer/CommandLineTools），Apple clang 21.0.0、GNU Make 3.81、Python 3.14.5、node-gyp 12.3.0 与 Node 24.14.0 headers。此机 node-gyp 来自已有 npm 工具链；未新增项目 node-gyp 依赖。T2 收口本机目标工具链、隔离安装和构建授权；托管 CI 是否具备 node-gyp/Python/编译器/make、目标 headers（首次可能需网络下载）及 pnpm 构建授权，移交 T9 验证。
- 上游 fs-ext 编译出现 5 条函数指针类型转换警告，但构建及实际 flock 测试成功，未修改原生依赖源码。optional 只允许非持久化安装继续，不允许持久化写入降级；目标构建/加载失败应视为 T2 阻塞。
- 未运行托管 CI；这不阻塞 T2，因为 T2 的责任是本机目标工具链和隔离安装收口；T9 负责把同一构建前提接入托管 CI 并报告 Linux、Windows、macOS x64 或其他 Node ABI 的结果。以上不代表未验证环境通过。

#### 项目检查与真实子进程验收

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm test && pnpm dev --help'
# 同一已构建产物，重复 3 轮锁测试：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'for attempt in 1 2 3; do pnpm exec vitest run tests/sessionLock.test.ts || exit 1; done'
```

- typecheck、lint、test 通过；pnpm test 在目标 Node 下先 clean/build，再运行 10 个文件、245 个测试。--help 用项目工具链运行成功，内容与阶段 03 行为一致；旧 CLI/REPL、wire、架构检查全部保留通过。
- [sessionLock.test.ts](../../tests/sessionLock.test.ts) 新增 25 项；真实子进程载入构建后的 adapter，通过 IPC ready/held/released 响应确认操作顺序；SIGSTOP 后轮询 ps 状态直到 T，SIGKILL 后等待 exit 再接管。不使用固定 sleep 猜时序。
- D01 锁层：同会话双进程一写一拒，busy 非阻塞返回；不同会话独立；同进程不同实例和准备中重复申请拒绝。启动退出 5 与 REPL picker 原历史保留属于 T8/T9，未提前声称完整 D01 通过。
- D02 锁层：闲置仍持有；SIGSTOP + 故意设置旧 mtime 不可抢占；描述符关闭和 SIGKILL/exit 后可接管，稳定文件 dev/ino 保留。共享读者持 shnb 时 probe 仍 available、exnb 仍 busy，实际区分了共享探测与独占写锁。
- D03 锁层：native 加载/导出失败、注入未支持平台与 Node、远程/未知挂载均安全拒绝；mkdir/open-create 前无落盘。实际阻止 native 模块加载的子进程中，import adapter、--help、--prompt 仍成功，加载尝试数为零，未创建临时 home 下的 .yucli。--prompt 使用本地 mock SSE，不访问真实模型。
- inode/权限：取得 flock 的回调期间替换锁路径，复核后拒绝交付；运行中替换是 ownership_lost，故障锁不复活，release 不删除新旧文件。新根/locks/锁文件权限、符号链接、路径穿越与不自动 chmod 均验证。
- D06 的 T2 边界：可控 Promise 暂扣真实 native 成功回调，期间另一个真实进程仍 busy，本进程登记也仍 busy；回调交付后才返回锁并允许正常释放。不设置提前关闭 fd 的锁超时。完整 30 秒 io_timeout、永不 settle/迟于 30 秒的 writer/store 操作、5 秒组合根退出属于 T7/T9，尚未实现或验收。
- 三轮重复锁验收各 25/25 通过（包含实际双进程、SIGSTOP/SIGKILL）；所有锁路径使用临时目录。research 文件未改动/未暂存，其初末 SHA-256 均为 987ce1368dd6e660a0b6fc3386ad6b19b1d4284cbda2ecc83157214b7a5a794b。
- probe 的正常路径在关闭只读 fd 后返回 busy/available/unknown；关闭失败沿 `PersistenceError(close_failed)` 向上抛出，不能被列表层降级为 unknown。T2 将该语义固定为存储故障退出 5；未将关闭失败伪装成状态未知。

#### 限制与下一步

T2 已完成且无阻塞，阶段整体仍为 implementing。advisory flock 仅协调遵守协议的写者，assertOwnership 是检查点而非文件系统事务，不对外部编辑器/父目录并发替换提供 OS 沙箱隔离。local 判定依赖 macOS mount 输出与最近存在祖先的保守匹配，拒绝已知非 local/未知结果，但不声称识别所有共享/用户态挂载或防止检查后的挂载变化；未在真实 NFS/SMB 或其他平台做安装/行为验收。

本次停止在 T2；下一次获得明确任务后才进入 T3。阶段分支提交仅含 T2 源码、测试、依赖与相关记录，保留用户 research 未提交修改，不合并 main、不推送、不创建标签。

### T3 格式与只读扫描：实际结果（2026-10-29）

本轮仅完成 T3，无阻塞；阶段保持 `implementing`，会话存储契约保持 `draft`。T4–T10 未勾选：没有 writer、fsync、备份/修复、SessionStore、picker、coordinator 或 CLI 接线；没有生成、补写或重跑业务事实。

#### 代码与实现选择

- [session.ts](../../src/contracts/session.ts) 新增运行摘要、安全错误、终止结果、业务事实数据、恢复业务组及完整稳定访问/存储错误。未实现事实 sink 或 writer/store 能力。原 [session-lock.ts](../../src/contracts/session-lock.ts) 重导出同一异常类，保留 T2 导入入口与 `instanceof` 身份。
- [sessionSchema.ts](../../src/adapters/session/sessionSchema.ts) 检查唯一 header、受管文件名/身份/创建时间、UTC 时间、精确字段集合、user 外层可选摘要、assistant 文本/最多 4 项调用及 `{path:string}` 参数、安全错误/outcome 配对。允许非空未知工具名，不查询注册表或执行工具。cwd 只校验规范绝对路径形状；当前 realpath 归属、目录权限与完整文件所有权规则留给 T4/T5。
- [sessionSequence.ts](../../src/adapters/session/sessionSequence.ts) 按物理顺序校验连续 seq、新 turn 唯一 user、turn 连续/身份不复用、终止边界、批内顺序及完整 `(turnId,callMessageSeq,toolCallId)` 引用。result/end 必须有 start 且唯一；end/悬空 start 不放行后项，前批全有正常结果才接受下一条 assistant。success 必须有最终回答和全部结果，`ok:false` 不阻止 success。
- 状态机推导工具 result/ended/not_started/unknown 与 interrupted turn；只保留最近 20 个完整成功业务组。失败/中断不进入成功窗口，旧 interruption 不覆盖后续真实结果，不在这里转换模型消息。预览只取第一条 user，清除控制字符、合并空白、按 80 个 Unicode 码点裁剪；原消息保留原文。
- [scanSession.ts](../../src/adapters/session/scanSession.ts) 提供 `scanSessionFile`（拥有并关闭只读 fd）和 `scanSessionHandle`（借用 fd，调用方关闭）；初次 fstat 固定 dev/ino/S，显式 read 位置仅解释 `[0,S)`，按 0x0A 分行并 fatal UTF-8 解码。所有偏移均为字节右开边界；后续追加只影响 changing 观察，不扩大本次范围。关闭失败为 `PersistenceError(close_failed)`。
- [scanTypes.ts](../../src/adapters/session/scanTypes.ts) 用 `status` 区分合法前缀与整个文件拒绝：合法分支提供 S/P、lastLfEndBytes、lastSeq、tailKind、列表统计及成功业务组；拒绝分支只提供来源与安全诊断，刻意不交付局部可恢复历史/边界。错误记录含物理行起点/右边界及可解析 seq/turn/调用引用，不输出正文。
- [jsonPrefix.ts](../../src/adapters/session/jsonPrefix.ts) 独立识别 complete/incomplete/invalid；显式维护对象/数组、字符串/转义/Unicode、数字和字面量状态，并先验证 UTF-8 continuation/码点范围。残缺 UTF-8 仅在普通字符串内容处可判 incomplete；不匹配 JSON.parse 错误文字、不只数括号。完整尾行仍通过全部业务校验。
- 本次新增/修改的函数、接口与关键状态均补充中文职责、输入输出/失败边界和步骤注释；复杂校验和资源清理分段说明。没有新增依赖或修改锁算法。

#### 验证命令与结果

以下为 T3 初版命令和 503 项通过记录；其工具错误上下文与单次使用保护的覆盖不足，已由后文“T3 审查修正”补测、修复并重新验证，初版通过不等于已完成审查。

目标环境为 macOS arm64 + Node 24.14.0 / pnpm 10.33.2；扫描测试全部使用临时目录，没有访问真实 ~/.yucli、读取 .env 或请求真实模型。

```bash
# 开发期间先运行 T3 定向验证：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm exec vitest run tests/jsonPrefix.test.ts tests/sessionScan.test.ts'
# 最终运行项目检查；pnpm test 自带 clean/build：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm test'
```

- typecheck、lint、test 及 test 内置 build 通过；共 12 个文件、503 项测试，其中 T3 两个文件新增 258 项。原 245 项（含 T2 原生锁真实子进程、CLI/REPL/wire 和四层架构约束）全部回归通过。
- B01：第 5 节合法组合逐条覆盖正反例；额外/缺字段、未知类型/角色、版本/文件名身份、序号、时间和非法运行摘要均拒绝。语义错误即使位于 EOF，或者前面已有 success，也拒绝整个文件。逐项断言物理行号、字节起点/右边界与必要引用，不跳行、不纠正。
- B02：跨批复用 ID、未知工具名合法；未来/非 assistant/旧 turn/旧批引用、名称/ID 错配、无 start、重复 start/result/end、result/end 双重终止和乱序/重叠均拒绝。
- B03：空白最终回答、success 缺结果/最终回答或带 error、非成功缺 error、错误分类/机器码及 HTTP 状态非法均拒绝。现有运行路径未修改，原 invalid_response 测试继续通过。
- B04：user-only、最终回答后缺 end、调用尚未开始/仅 start/前项已有结果/异常终止、合法非成功 end、旧中断后新 success 均验证。已知结果和异常保留；有 end 且无 start 才是 not_started；无 end 或已有 start 而无终止为 unknown。仅完整 success 进入最近 20 组窗口，失败不占窗口。
- B05：1/2/3/7/65536 字节读取、中文/emoji 跨块、对象/数组与所有 token 阶段、合法 UTF-8 边界/残片及过长/代理区/越界编码均覆盖。字符串内外同样残片分类不同，有 LF 的坏行与完整但 schema/seq/引用/生命周期非法的无 LF 尾行拒绝；测试逐字节遍历复杂合法对象的前缀。
- B06 **只读子集通过**：missing_lf 计入该记录与 lastSeq，validEndBytes=S；incomplete 不计残片，validEndBytes/lastLfEndBytes=P。每次文件测试扫描前后比对原始 Buffer，并断言临时目录仅保留原日志，无补 LF、截断、备份或新目录。持锁备份、修改、sync 和重验属于 T5，本轮未实现/未验收，不宣称完整 B06 通过。
- 显式借用真实 fd，在首次 read 前追加数据，验证初始 S 边界/changing；模拟初始范围提前 EOF 拒绝，模拟读取异常脱敏且不提前关闭借用 fd。缺路径不建目录，目录/末端符号链接拒绝。

#### 限制与下一步

T3 已完成；整个阶段与 B06 写恢复部分尚未完成。分块扫描不代表单行内存有界，JSON.parse 仍需完整行，当前 turn/最近成功业务组可能较大，turn/调用诊断数量也无硬上限。只读 S 和前后 fstat 不是原子快照；changing=false 不构成可写许可或排除同大小并发改写的保证。后续可写恢复必须持独占锁重新定位/扫描并按 T5 备份修复，不能复用本次只读边界直接续写。

未验证 Linux、Windows、macOS x64、其他 Node 版本、远程文件系统和设备断电耐久性；本次没有修改真实服务或 CLI 行为，也未做真实模型联调。30 秒存储期限/5 秒退出监督继续由 T7/T9 交付。用户 research 的未提交修改保持原样，其 SHA-256 仍为 `987ce1368dd6e660a0b6fc3386ad6b19b1d4284cbda2ecc83157214b7a5a794b`，不纳入 T3 提交。

本次停止在 T3，T4 需下一次明确授权。T3 代码、测试及相关文档提交到 `phase/04-session-persistence`；不合并 main、不推送、不创建标签。

#### T3 审查修正：工具终止上下文与校验器生命周期（2026-10-29）

审查确认两项真实缺陷：初版 termination 只用布尔参数区分 success，却让 tool_end 复用了完整 turn 错误配对；B04 和部分生命周期反例误用 model/network 工具异常 fixture，固化了错误行为。SessionSequence 注释承诺单次使用，但没有失败/完成保护，导出 API 可以在错误后继续或在 finish 后改动已返回的读模型。初版“测试通过”不足以证明这两项语义正确。

- `termination(payload, kind)` 现在明确区分 tool_end/turn_end，只复用安全错误的字段校验。tool_end 仅接受工具执行失败和两种取消；model/network、model/http、model/invalid_response、protocol、limit、internal 及所有工具 timeout 均拒绝。turn_end 保留原完整配对和 request_timeout。完整无 LF 尾行应用相同上下文规则，错误仍拒绝整个文件。
- contracts 新增较窄的 ToolEnd，磁盘记录、core 事实数据声明和工具诊断使用同一类型；FailureEnd 仅保留为 turn 级异常结束。没有新增 tool_timeout 码、工具期限、运行期事实交付或 writer。
- 测试将 turnFailure/toolFailure 分开；B04 的“旧中断含已知工具异常”及重复/越序/终止反例均使用合法工具错误，确保继续验证预期的生命周期拒绝位置。另加 8 个非法上下文/超时反例和 3 个合法工具失败/取消正例。
- SessionSequence 新增 failed/finished 标志；accept 首次错误保留原原因并永久拒绝继续/finish；finish 成功后拒绝 accept/重复 finish。非法重用抛内部安全诊断 `validator_state`，不推进 lastSeq、不再修改已返回的数组。新增 7 项直接 API 测试，覆盖空实例完成、成功实例完成及首条/已有记录后的 seq、引用和生命周期失败，不仅依赖扫描器的正常调用顺序。

先在旧实现执行新增定向用例，173 项中 14 项失败，分别复现 7 个上下文错误放行和 7 个单次使用保护缺失；`tool_timeout` 当时因机器码未定义已经被拒绝，仍加入反例防止后续提前放行。实现修正后执行：

```bash
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm exec vitest run tests/sessionScan.test.ts tests/sessionSequence.test.ts'
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm test'
```

目标 macOS arm64 / Node 24.14.0 下，定向 173 项通过；最终 typecheck、lint、build（test 内置）与全部测试通过：13 个文件、521 项测试，较初版新增 18 项。原扫描/前缀、原生锁子进程、CLI/REPL/wire 和架构测试全部回归通过。测试使用临时目录，不访问真实 ~/.yucli，不读取 .env 或调用真实模型。

本次修正已实现并验证，供再次审查；阶段仍为 implementing，契约仍为 draft，没有进入 T4。B06 写恢复与单行/深度无硬上限的限制不变；分块扫描不能作为有界单行内存承诺。research 文件内容哈希不变，不暂存、不提交；仅将本次 T3 修正提交到阶段分支，不合并、不推送。

### T4 文件与 writer：实际结果及开发报告（2026-10-29）

状态：`completed`（仅 T4）。已完成本任务，无部分完成的 T4 项、无阻塞。阶段整体仍为 `implementing`，会话存储契约仍为 `draft`。本节同时作为本轮结构化开发报告，不另建重复报告。

#### 完成内容与修改文件

- [session.ts](../../src/contracts/session.ts) 增加 `SessionWriter`、`SessionSnapshot`、`OpenedSession`，沿用既有事实、错误及恢复业务数据；没有声明假实现的完整 SessionStore、sink 或协调器。
- [SessionFileAdapter.ts](../../src/adapters/session/SessionFileAdapter.ts) 提供 T4 的 `create(cwd)` 和资源级 `close()`。构造无 I/O；先调用 T2 平台/native/local 预检，验证 cwd 已是实际目录的规范 realpath，再逐级创建/检查 0700 的 root/sessions。新身份必须为 UUID v4，header 和文件名时间共用一次时钟取值；碰撞最多三次，其他错误不重试。
- [SessionWriterAdapter.ts](../../src/adapters/session/SessionWriterAdapter.ts) 在已取得 T2 锁后登记正文资源。检查扁平受管名称中不存在同 ID，再以 `O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_NONBLOCK`（wx+ 独占语义）创建 0600 最终正文。打开后和每次保存前/同步后复核 root/sessions、正文路径/fd 的 dev/ino、所有者、私有权限、类型、单硬链接及预期大小；同时调用 T2 assertOwnership，不复制/修改锁算法。
- header 完整写入并 `FileHandle.sync()`，随后同步 sessions、locks、root 和 root 的父目录，关闭临时目录 fd，再交付 writer/空快照。必要目录同步失败也是创建失败；不静默跳过。创建与后续 user 不是原子事务，失败产物原样保留，包括不完整 header；不补假 user、不 unlink、不覆盖。
- [sessionFact.ts](../../src/adapters/session/sessionFact.ts) 在 append 入口深拷贝交付事实，检查内存外壳的精确字段、必填 user 摘要和工具结果 ID/name 配对。消息、工具参数、安全错误、磁盘 schema 与顺序分别复用 T3 `validateSessionRecord`、`SessionSequence.accept`；新增校验只覆盖内存 assistantId/CallRef 与磁盘形态的差异。
- writer 串行实际 I/O；从最后确认 seq 分配下一序号，编码 JSON + LF，按实际字节数循环补齐短写，等待 sync 并复核身份后才确认。`(turnId, assistantId)` 只映射到已确认 assistant seq，工具引用转换为 callMessageSeq，批次配对继续由 T3 检查；新 user 隔离旧中断 turn，turn_end 确认后清空临时映射。不同批次/turn 复用 toolCallId 不串配。
- write/sync、契约或所有权失败永久故障，后继队列/append 拒绝，不重试不确定写入、不递归保存错误事件。异常只带安全 code/operation、lastConfirmedSeq 和已知记录起点的字节偏移，不泄露底层错误/正文。完整行存在不代表调用方已得到保存确认。
- writer.close 首次调用停止新 append，重复返回同一 Promise；等待已排队 I/O 真正 settle，正文及临时目录句柄关闭成功后才调用 T2 release。关闭失败保留锁与资源登记，不重试不确定的 close。文件 adapter 在首次 await 前登记 create，整体 close 同样幂等，等待未交付的锁/header 准备完成再收尾；单个 writer 成功关闭后移出登记，失败资源继续保留。
- [sessionFileIO.ts](../../src/adapters/session/sessionFileIO.ts) 提供窄的 I/O 注入，默认直接委托 Node；时钟、UUID、T2 锁能力均可注入。没有新依赖、生产假模型客户端、CLI/env 根路径配置或后台刷盘。新函数/接口和异步状态补充中文职责、字段及失败/清理说明。
- [sessionWriter.test.ts](../../tests/sessionWriter.test.ts) 新增 69 项。architecture、session-store 和 ADR-006 仅同步 T4 实际状态，未变更已确认的格式或阶段范围。

#### 设计决策

- T4 的文件创建/资源所有者命名为 SessionFileAdapter，未来由完整 store 组合；本轮没有用抛“未实现”的 openWrite/list 占位，也没有提前修改 core/bootstrap。
- 事实入口结构校验/快照同步完成；涉及已确认映射及跨记录状态的校验，在串行队列实际发出 I/O 前完成。调用方仍须逐条 await 屏障；内部串行不能被解释为允许业务 fire-and-forget。
- 字节写入确认与 durable 确认分开。write 回调丢失、sync 拒绝时可能已有完整行；writer 不回滚校验器、不复活或尝试同 seq。未来 T5 只能重新持锁扫描实际证据。
- 每条成功记录已经同步，close 不对故障尾部补写或修复，不额外产生 session_end。所有 fd 的 close 结果被缓存，失败不再次操作可能已被系统复用的描述符；任何关闭不确定都不能提前释放会话锁。

#### 验证命令与结果

实际环境为 macOS arm64、Node **24.14.0**、pnpm **10.33.2**；未使用全局 Node 26 执行检查。全部磁盘用例使用显式临时根/cwd，使用真实 T2 flock，故障/时序仅由 I/O 包装和可控 Promise 注入；不靠固定 sleep、不访问真实 ~/.yucli、不读取 .env、不请求模型。

```bash
# 首轮定向：64 项；补充打开后/关闭竞态后：T4 69 项 + T3 173 项 = 242 项。
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm exec vitest run tests/sessionWriter.test.ts tests/sessionScan.test.ts tests/sessionSequence.test.ts'
# 最终项目检查，pnpm test 包含 clean/build：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'node --version && pnpm --version && pnpm typecheck && pnpm lint && pnpm test'
```

- typecheck、lint、build 与全套测试通过：**14 个文件、590 项测试**（原 521 项 + T4 69 项）。现有 T2 真实子进程/暂停/死亡互斥、T3 格式/扫描、CLI/REPL/wire 和四层依赖检查全部回归通过。
- A03 的 T4 子集：同毫秒新建身份不同；受管名称存在同 ID 多文件时三次碰撞拒绝；readdir 与 wx 之间出现普通文件/符号链接仍不覆盖目标并换新 UUID；一般 I/O 错误仅尝试一次。创建失败不交付 writer；后续模型行为属于 T7/T8。
- B02/C02 的 writer 子集：header/user/两批复用 ID 的 assistant/start/result/最终 assistant/end，seq 1–9 连续；工具 end 后新 turn 的 a1/同调用 ID 可复用。未知/旧批/跨 turn 引用、结果 ID/name 错配、重复 assistantId、非法角色/附加字段/错误终止和缺 profile 均在写前拒绝，原字节不变。失败后拒绝后继事实；本轮没有验收跨 core/注册表传播或模型历史提交。
- 短写分别限制为每次 1/2/7 字节，中文/emoji 跨片仍完整；零进度、负数、非整数、NaN、无穷或超长计数拒绝且不循环。短写后失败保留 torn_tail 和原合法前缀；write 已完成但回调丢失、sync 已执行后拒绝时扫描可见完整行，但 lastConfirmedSeq 不推进、后继队列不写入。
- 以 T3 `scanSessionFile` 检查健康文件、header-only、异常终止、失败残片和未确认完整行；同一正常文件再用借用 fd 的 `scanSessionHandle` 验证结果一致。创建失败的半 header 正确返回 rejected，不编造可恢复前缀。原字节无截断、补 LF、recovery 备份或修复。
- D04 的 T4 子集：0700/0600、规范 cwd、非目录 cwd、root/sessions symlink/错误类型/宽权限/模拟异主均验证；打开后改权限/加硬链接/换 inode 在 header 首字节前拒绝。运行中正文、目录、锁的替换及权限/所有者/硬链接变化永久 ownership_lost，不写替换产物、不自动 chmod。T2 既有锁符号链接等边界同时保持通过。
- D05/D06 的资源子集：以可控 Promise 暂扣 user write/sync、正文 close、创建中的 header sync 和未交付锁能力，确认收尾一直持锁、等待实际 settle；成功顺序为正文 close 后 release。close 重入同一结果；正文/临时目录/锁 release 的关闭失败均报告 close_failed，失败 fd 不再次 close，未返回 writer 的失败资源仍由文件 adapter 登记。

#### 部分完成、未完成与阻塞

T4 已完成；没有 T4 部分项或阻塞。A03、B02/C02、D04–D06 的上述结果仅是文件/writer 子集，不表示完整阶段矩阵已验收。T5 的 openWrite、成功历史恢复、备份、truncate/补 LF/repair；T6 的 core 事实交付；T7 的协调器、30 秒/5 秒监督；T8 的 picker/CLI/list；T9/T10 的集成/完成审查均未进入，勾选保持未完成。

#### 风险与交接

- advisory 锁与身份检查点不能隔离外部编辑器或所有父目录替换竞态；同大小外部改写不能仅凭 dev/ino/大小发现。0600 不等于加密，sync 不是所有设备断电绝对耐久承诺。
- 沿用 T3 单行、当前 turn 与诊断无字节硬上限的限制；本轮不增加不对称读写上限或完整 store 的查询能力。
- 正文/目录关闭不确定时故意保留锁。T4 不设超时、不直接退出进程；后续必须由 T7 处理永久不 settle 和关闭失败的进程收尾，不得改成提前解锁。没有验证其他平台、Node 版本、共享文件系统或实际设备断电。

#### Git 状态

工作分支为 `phase/04-session-persistence`；本次仅提交 T4 源码、测试及相关正式文档，不合并 main、不推送、不创建标签。用户 research 文件保持原有未提交修改，不暂存、不提交，SHA-256 仍为 `987ce1368dd6e660a0b6fc3386ad6b19b1d4284cbda2ecc83157214b7a5a794b`。提交 hash 在交付回复中报告。

### T5 存储恢复与修复：实际结果及开发报告（2026-10-29）

状态：`completed`（T5 存储范围已完成并提交为 `13ba764`）。部分完成：无本轮 T5 部分项。阻塞：无。阶段仍为 `implementing`，契约仍为 `draft`；T6 已完成并提交为 `f61164f`，T7–T10 尚未开始。

#### 完成内容

- `SessionFileAdapter.openWrite({ sessionId, cwd })` 实现安全定位、T2 预检/独占锁、持锁重新定位、r+ 打开、全文件扫描、必要修复及业务快照交付。缺路径/候选返回 not_found，不代建正文/目录；多正文返回 invalid_identity，不按 mtime 任取。busy 原样拒绝，不改选其他会话。
- cwd 在取锁前必须是实际目录的规范 realpath，随后与 header.cwd 精确相等；root/sessions/正文检查所有者、私有权限、类型、单硬链接和 dev/ino/大小。正文打开不带 CREAT/TRUNC/APPEND。扫描复用 T3 scanSessionHandle，损坏/不支持拒绝整个文件，不恢复局部成功前缀；准备期观察到变化拒绝。
- 完整文件不创建 recovery、不改字节，仅同步合法前缀，snapshot.repair=none。missing_lf 备份后只在 S 补 LF，lastSeq 已包括完整尾行；incomplete 备份后只截到 P，残片不计 seq。两者均对同一正文 fd sync，再重扫实际文件并核对 seq、完整 LF、有效边界、实际大小、身份和保留前缀摘要。
- 备份复制恰好 [0,S) 的原始字节，包含残片、原 JSON 空白/字段顺序和多字节 UTF-8。备份/清单使用同一次新时间与 UUID，wx + NOFOLLOW/NONBLOCK 创建 0600 文件，0700 recovery/<sessionId> 容器逐级检查。原件、复制结果、备份大小/摘要及清单字节均复核；文件和每级必要目录同步且临时关闭确认完成后，才进入正文修改。
- 修改前再次核对源 dev/ino、大小、时间观测和 SHA-256。用户已明确确认 §8 的失败边界：修改前失败不改变正文；修改生效后的 sync/重验失败保留实际字节与完整备份，不回滚、不删产物、不重试旧边界、不交付 writer。普通修复失败为 repair_failed；关闭不确定优先报告 close_failed，保持资源登记/锁。
- 快照交付原 meta、最近最多 20 个完整 success 业务组、最近 user 摘要或缺失、中断计数和 repair。失败/取消/超时/中断不进入成功窗口，不重建旧执行、不生成 ToolMessage、不暴露磁盘 seq/assistantId。按已确认范围，纯模型投影正式移至 T6 core 任务，不计作 T5 已交付能力。
- 恢复后的 writer 使用全新 T3 校验器，只继承 lastSeq 和所有旧 turnId 的拒绝集合，不复活已 finish/failed 的扫描实例，不重建旧 a1/a2；首条必须是新 user/turnId，seq 从 lastSeq+1 开始。继续共用 T4 的事实快照、引用转换、短写、sync、永久故障和幂等 close；header-only 从 1 开始。
- openWrite 在首次 await 前登记准备任务；取锁即登记 writer。正文扫描直接借用 fd，无额外扫描 fd 待关闭。恢复/修复中的临时 fd 同样归 writer 管理，所有 I/O 真正 settle、正文/临时 fd 关闭成功后才 release。失败未返回 writer 时也不泄漏或提前放锁，整体 close 可等待未完成的恢复操作。

#### 实际修改文件

- [SessionFileAdapter.ts](../../src/adapters/session/SessionFileAdapter.ts)：最小扩展 openWrite 和既有整体资源登记，不实现 list 或完整产品 store。
- [SessionWriterAdapter.ts](../../src/adapters/session/SessionWriterAdapter.ts)：增加已有文件初始化、扫描/修复/快照、恢复起点确认，继续复用同一追加/关闭算法。
- [repairSession.ts](../../src/adapters/session/repairSession.ts)：新增持锁备份、SHA-256、清单/目录同步、修改前复核、同 fd 修改与重验。
- [sessionFilename.ts](../../src/adapters/session/sessionFilename.ts)：提取 T4 命名规则供创建碰撞与恢复定位共用；仅定位，最终身份/时间/版本仍交 T3 schema 扫描。
- [sessionFileIO.ts](../../src/adapters/session/sessionFileIO.ts)：增加实际定位 read/truncate 注入，提取共用 writeSessionBytes 短写循环；未增加依赖。
- [sessionSequence.ts](../../src/adapters/session/sessionSequence.ts)：新增 forAppend 工厂，为已持锁验证的完整前缀创建新校验器，保留原单次使用保护。
- [contracts/session.ts](../../src/contracts/session.ts)：仅同步会话业务类型的中文注释（含 T6 投影归属），没有改变磁盘格式/跨层数据结构或新增完整 SessionStore。
- [sessionRecovery.test.ts](../../tests/sessionRecovery.test.ts)：新增 102 项测试；现有 T3/T4 测试未改动。
- 本规格、[session-store](../contracts/session-store.md)、[architecture](../architecture.md)、[ADR-006](../decisions/ADR-006-session-persistence.md)：同步 T5 实际边界、已确认失败语义与未实现项；审查收口时同步 README、docs README 和上级 `agent-lab/plan.md` 的 T5 状态，research 未修改。

#### 关键设计选择

1. 先只读排除缺失/多候选，再取得 T2 锁并正式重新定位/打开/扫描，不沿用只读列表缓存；T2 算法不变。完整文件也同步合法前缀，再作为本次 writer 的确认起点，不把只读 lastSeq 直接当 durable 证明。
2. T3 扫描器、schema、格式、JSON 前缀算法均不改；只给 T3 sequence 增加新实例工厂。它的旧 turnId 集合防止复用旧成功/中断身份，旧调用映射故意不恢复，原扫描实例的 finish 后保护保持有效。
3. T4 写入算法提取为公用字节写入原语，记录、备份/清单、补 LF 都使用它；错误分类仍由对应生命周期负责，不复制一套 writer 或对不确定写入重试。备份块最大 64 KiB，允许短读/短写，单行解析的既有限制不变。
4. 扫描借用正文句柄，全部修复产物 fd 委托同一 writer 资源集合。临时 close 失败不在原 fd 上重试，不能为了返回拒绝就提前解锁；T7 的永久挂起监督仍待后续任务。
5. 修复不是原子事务：不承诺修改后失败仍保持原字节。备份/清单不是自动还原标记；再次打开只按实际文件重扫，若文件已健康，不重做备份或旧修复。

#### 验证命令与实际结果

实际目标为 macOS arm64、Node **24.14.0**、pnpm **10.33.2**。本轮先运行原基线：typecheck/lint/build 和 14 文件、590 项全部通过。扩展后旧 T3/T4 定向 242 项通过；T5 初版 51 项中 50 项通过，唯一失败是 ASCII header-only fixture 误断言“UTF-8 字节数大于字符串长度”，已修正为只对含多字节正文的 fixture 断言。开发中的默认 UUID 参数类型推断和测试 Lint 问题已修正，未把失败预检写成通过。

```bash
# 开发定向：旧 T3/T4 242 项；T5 故障矩阵扩展至 96 项时全部通过。
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'pnpm typecheck && pnpm lint && pnpm exec vitest run tests/sessionRecovery.test.ts'
# 最终新增持锁重定位、时间精度兼容和旧 turn_end 反例后执行全套：
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 --call 'node --version && pnpm --version && pnpm typecheck && pnpm lint && pnpm test'
```

最终 typecheck、lint、test 内置 clean/build 和全部测试通过：**15 个文件、692 项测试 = T4 基线 590 项 + T5 新增 102 项**。现有原生锁子进程、T3 格式/扫描、T4 写入/故障/关闭、CLI/REPL/wire 和四层架构测试全部回归通过。未使用全局 Node 26 验证。

- openWrite：缺失根/正文、非法 ID、规范路径/符号链接/非目录/其他 cwd、busy、损坏/不支持、同 ID 多文件均覆盖；取锁后出现第二候选或文件改名再次拒绝。受管名称区分带下划线的其他 ID/非受管后缀，保留 T3 无小数秒/任意小数精度的合法创建时间。
- 成功窗口：23 个成功 turn 穿插普通失败，另有取消/超时和两个中断，仅最近 20 个 success 进入快照；最近 user 缺摘要不继承旧配置。工具 ok:false/空内容保留为 ToolResult；新 a1/同 toolCallId 按新的 assistant seq 配对；修改返回快照不改变内部旧 turnId 集合。旧 user/turn_end 和旧工具引用不允许续写。
- B06/B09：缺记录 LF、缺 header LF、可完成 JSON 残片、半个 UTF-8 字符，均验证完整备份字节、实际 S/P/lastSeq、SHA-256、清单内容、同时间/UUID、0700/0600、所有必要同步先于正文修改，以及实际重扫。大原件使用 997 字节短读/401 字节短写仍逐字节一致；旧 JSON 和未知工具证据保留，不补假结束/结果。后续 seq 连续，健康二次打开不重复备份。
- B07：ENOSPC/备份创建、复制读取、完整/部分/零进度备份写、备份 sync/摘要、清单创建/写/sync/摘要、目录打开/sync、根 sync、修改前源摘要异常均保持正文原字节、不交付 writer；未完成产物保留。备份后源内容同大小变化、源 inode/大小或锁 inode 替换停止本次修改，不覆盖外部修改。recovery 目录的链接/宽权限/模拟异主与产物 wx 文件/链接碰撞均拒绝，不 chmod/覆盖/换身份重试。
- B08：truncate/补 LF 在调用前拒绝、已生效后确认丢失、假成功但实际未修改、正文 sync 拒绝、重扫读取失败/仍缺 LF、保留前缀摘要不符，均报告 repair_failed、只尝试一次修改、不交付 writer。修改前失败保持原文，修改后保留实际字节/原件备份；模拟下一次打开已健康的文件，repair=none，不重复备份/旧边界。此为存储故障与二次打开子集，没有声称已运行真实 SIGKILL 修复进程或 T7 超时监督。
- D04：root/sessions/正文符号链接、错误类型、宽权限、模拟异主、硬链接，及打开时正文替换/增长/消失、目录替换和扫描期间增长均拒绝。扫描失败的正文 close 故障、修复临时目录 close 故障均返回 close_failed、不重复关闭、仍登记并持锁。
- settle/收尾：分别用可控 Promise 暂扣备份 write、已生效的 truncate 和修复后扫描 read，整体 close 始终等待实际 I/O，期间仍 busy；完成后先关正文再 release，close 重入同一结果，不接受新 openWrite/append。恢复后的 append sync 失败继续保留已落盘但未确认事实，永久拒绝后继 append。

所有新增磁盘用例使用显式临时根与真实 T2 flock；I/O/时钟/UUID/延迟均可控，不靠固定 sleep 猜顺序。没有访问真实 ~/.yucli、读取项目 .env、发模型请求或引入假模型客户端。

#### 部分完成、阻塞与未完成事项

本轮 T5 存储目标全部实现，无部分项或阻塞，待用户审查。纯模型消息投影已正式移至 T6；没有实现完整 SessionStore/list、picker、CLI/REPL 接线、core 事实交付、runPersistentTurn、30 秒操作期限、5 秒故障收尾、进程退出监督或任何 T6–T10 功能，也没有真实模型联调。

#### 未验证平台与限制

仅验证当前 macOS arm64、Node 24.14.0、本地文件系统；未验证 Linux/Windows/macOS x64、其他 Node/共享挂载或实际设备断电。T4 记录的 `storageRoot` 父目录本身为符号链接时目录 `O_NOFOLLOW` 同步可能失败，T5 未处理；默认 `~/.yucli` 不受影响。没有新增记录/单行字节硬上限，T3 单行/当前 turn/诊断内存成本不变；备份按块不等于全流程内存有界。advisory 锁与多次身份/摘要复核不隔离任意外部编辑器或所有父目录并发替换。备份含敏感原文、不加密、不自动清理；完整原件和摘要复核需要额外磁盘/读取成本。关闭或 I/O 永久挂起仍需 T7 监督，T5 不提前解锁、不直接结束进程。

#### Git diff/status（实现完成时快照）

以下保留实施完成时的工作区记录；后续授权提交情况见本文件末尾补记。

- 分支 `phase/04-session-persistence`，HEAD 保持 `e7279fa`；未 commit、push、merge 或创建标签，所有 T5 改动留工作区、未暂存。
- 本轮改动为上述 T5 源码/测试/正式文档；审查收口时同步更新了 README.md、docs/README.md 和 `agent-lab/plan.md` 的 T5 存储范围状态，并把纯模型投影正式归入 T6。`agent-lab/plan.md` 位于上级目录、不属于 yucli Git 仓库。
- research 文件未编辑/暂存/提交，SHA-256 保持 `987ce1368dd6e660a0b6fc3386ad6b19b1d4284cbda2ecc83157214b7a5a794b`；本轮结束时保留其原有未提交修改。

### T6 core 交付与纯模型投影实际结果（2026-10-29）

状态：`completed`（仅 T6，实现完成时待审查、未提交；现已获用户授权提交，见末尾补记）。已完成本轮授权范围；部分完成：无；阻塞：无。阶段保持 `implementing`，阶段 04 扩展契约仍为 `draft`，T7–T10 未勾选。

#### 完成内容

- 新增纯 `toolResultToMessage`，实时流式/非流式兼容循环与恢复共用。ToolResult 保留 ok，包括 ok:false 和空文本；模型消息显式复制 role/toolCallId/name/content，不带 ok、磁盘 seq、callMessageSeq、runtimeProfile 或 assistantId。
- 新增纯 `projectSessionHistory`，将 T5 已验证的 RecoveredItem/RecoveredTurn 业务组转为 `Message[][]`，按原顺序整组取最近 20 个 success，并复制嵌套调用。失败/取消/超时/中断由 T5 成功窗口排除，不拼接失败问题，不重跑模型或工具，不重建旧执行。
- `runTurnStream` 增加末尾可选执行上下文，完整流/assembler/整批预检后交付 assistant，当前 turn 内编号 a1/a2，包含最终回答和额度末次合法工具请求。逐项 start/result/end 都等待 sink 确认；无 context 路径保留兼容行为。没有新增 user/turn_end 所有者或提交凭证。
- `RegisteredTools` 返回合法完整输出后先创建配对 ToolResult；执行器先保存结果再检查取消，不覆盖已取得输出、不重复终止同 call。start 确认后的分派前取消保存 cancelled_before_dispatch；进入注册表后的实际取消保存 user_interrupt。真正内部异常使用固定安全 ToolExecutionError 分类为 tool/tool_execution_failed；保存错误原样穿透，不递归结束、不重试。
- 保留整批预检、顺序执行、每批 4 次工具和每 turn 8 次模型调用；未改 StreamAssembler、ReadFileTool、adapter 或 bootstrap。同步更新契约、架构、ADR 和 T6 勾选；adapter 继续只依赖 contracts，不反向依赖 core。

#### 实际修改文件与 T5 拆分边界

本轮 T6 涉及 14 个文件（4 新增、10 修改）。T5 开始前已有修改以本轮入口快照和 SHA-256 核对，未做暂存或提交。

| 归属 | 文件 | 本轮处理 |
| --- | --- | --- |
| T6 新增 | `src/core/toolMessage.ts`、`src/core/sessionHistory.ts` | 纯工具消息转换及成功历史整组投影 |
| T6 新增 | `tests/coreFacts.test.ts`、`tests/sessionHistory.test.ts` | 分别新增 48 和 9 项测试 |
| T6 修改，入口时干净 | `src/contracts/tool.ts`、`src/core/runTurnStream.ts`、`src/core/toolRegistry.ts`、`src/core/agentLoop.ts`、`docs/contracts/tool-execution.md` | 工具异常、逐项交付/取消边界、共用转换及契约说明 |
| T5/T6 共享，需按 hunk 拆分 | `src/contracts/session.ts` | 保留 T5 的恢复快照注释；T6 新增 sink/context 及事实职责说明 |
| T5/T6 共享，需按 hunk 拆分 | `docs/architecture.md`、`docs/contracts/session-store.md`、`docs/decisions/ADR-006-session-persistence.md`、本规格 | 保留 T5 记录，追加 T6 状态、实现和实际验证 |
| T5 原有未提交修改，T6 未编辑 | `src/adapters/session/SessionFileAdapter.ts`、`SessionWriterAdapter.ts`、`sessionFileIO.ts`、`sessionSequence.ts`、新增 `repairSession.ts`、`sessionFilename.ts`、`tests/sessionRecovery.test.ts` | 与入口基线 SHA-256 一致，仍留工作区 |
| 其他既有修改，T6 未编辑 | `README.md`、`docs/README.md`、`docs/research/session-persistence-research.md`、上级 `agent-lab/plan.md` | 与入口基线 SHA-256 一致；plan 不属于 yucli Git 仓库 |

#### 设计决策

- RecoveredTurn 按既有契约只表示已验证完整 success，不新增 outcome 或在 core 复制 T3/T5 的扫描状态机。纯投影返回分组数组，使后续 REPL 保持整组裁剪；合法输入仍由存储边界保证。
- 增加可选末尾 context，保留原调用签名的所有既有位置，不扩大非流式兼容循环的事实交付职责。ToolMessage 不通过 spread 从 ToolResult 构造，防止存储字段随结构扩展进入模型。
- 工具返回业务输出与文件工具内部读取检查点分开：ReadFileTool 尚未返回的读取仍可取消；一旦注册表得到合法输出，结果先交付。工具执行 catch 只负责业务分类，正常事实保存放在该 catch 外，end 保存失败也直接传播。
- 沿用规格 §6 的边界：最终 assistant 确认后返回的仍是临时 StreamTurnResult，固定 outcome、turn_end 保存、CommittedTurnResult 和 REPL 历史提交属于 T7。未发现阻止 T6 实现的规格/契约缺失或冲突。

#### 验证命令与结果

实际环境为 macOS arm64（`uname -sm` 输出 `Darwin arm64`），命令确认 `node --version` 为 `v24.14.0`、`pnpm --version` 为 `10.33.2`。

```sh
npm exec --yes --package=node@24.14.0 --package=pnpm@10.33.2 \
  --call 'pnpm typecheck && pnpm lint && pnpm test'
```

- 完整验证通过：typecheck、lint、`pnpm test`（先 clean/build 再 vitest）；**17 个测试文件、749 项测试全部通过**。T5 基线 15 文件/692 项，本轮新增 2 文件/57 项；T4 基线为 590 项。执行时同一命令另打印 Node/pnpm 版本用于核对。
- 定向验证通过：既有 `agentLoop.test.ts`、`stream.test.ts`、`toolHttp.test.ts` 共 3 文件/110 项；新增 `coreFacts.test.ts`、`sessionHistory.test.ts` 共 2 文件/57 项。新增测试首次 typecheck 发现测试 HTTP 回调的返回类型不匹配，修正后通过；另修正非法 SSE 帧放在 DONE 后的 fixture，使其实际覆盖 message_end 后但 generator 结束前的拒绝路径。
- C01–C05 的 T6 子集：可控 Promise 暂扣 assistant/start/result/end，后继动作不能越过确认；各处保存拒绝在并发取消时仍原样穿透，不递归保存或继续执行。工具结果和结果保存期间取消先保留结果；分派前取消不调用注册表；第一项完成后第二取消、工具后模型失败、最后合法调用但额度耗尽、未知工具均保留准确事实。
- B02/B03 及恢复投影子集：两批复用 toolCallId 按不同 assistantId 配对；非法批次/空白/截断/缺 end/非法收尾不交付伪造 assistant。实际 T4/T5 writer 保存后 openWrite，恢复投影与实时完整消息组一致；failed/cancelled/timeout/interrupted 排除，24 个 success 取最后 20 组，不重放请求或工具。
- 全量保留额度、顺序、非流式/单次/CLI 产物及架构依赖回归；测试仅用本地 mock SSE 和显式临时存储，没有新增生产假模型客户端、读取项目 .env、触碰真实 ~/.yucli 或请求真实模型。

#### 未完成事项与未验证边界

T6 无部分项或阻塞。未实现 T7 的 runPersistentTurn/user/唯一 turn_end、提交凭证、30 秒期限、5 秒退出监督，未实现 T8 的 list/picker/CLI/REPL 接线；这些仍按既有规格后续交付。T6 sink 的接口和测试桥接不表示产品持久化路径已经连通。

后续接线需注意：静态检查现有 `bootstrap/output.ts` 的 reportError 尚未识别新的 ToolExecutionError，会落入安全的未分类错误分支（返回 1）；T8 接线时应按 §9 补齐工具业务错误的安全显示和单次退出码 4。本轮按授权保持 bootstrap 不变，未将这一 CLI 故障分支计为 T6 已验证的产品行为。

仅验证目标 macOS arm64/Node 24.14.0/本地文件系统；未验证其他平台/Node、共享挂载、真实设备断电或真实模型联调。T5 存储内存、advisory 锁及备份限制不变；永久挂起和故障退出需 T7 监督。恢复投影消费可信业务快照，不独立接受未经 T3/T5 校验的任意 JSON。

#### Git diff/status（实现完成时快照）

- 分支保持 `phase/04-session-persistence`，HEAD 保持 `e7279fa`；未暂存（cached diff 为空）、commit、push、merge 或创建标签，所有修改留工作区待审查。
- T5 adapter/测试和其他既有修改逐文件 SHA-256 与入口基线一致；共享文档和 session 契约按上表追加 T6 hunk，后续拆分提交时不能把全部未提交 diff 一概视作 T6。
- `git diff --check` 通过，新增/修改文档的本地链接目标均存在。工作树共 24 项（17 个已修改、7 个未跟踪）；普通 `git diff --stat` 只统计已跟踪文件，含 T5/既有修改，不能作为 T6 独立 diff。T6 本轮为 14 文件（4 新增、10 修改），其中 5 文件与 T5 共享。

#### 提交授权补记（2026-10-29）

- 用户在 T5/T6 验证通过后授权提交，覆盖此前“不要 commit、留工作区审查”的约束；仍不推送、不合并 main、不创建标签、不进入 T7/T8。
- T5 单独提交为 `13ba764`（`feat(session): implement T5 recovery and tail repair`）。从准确暂存树导出到临时目录，目标 Node 24.14.0/pnpm 10.33.2 下重新通过 typecheck、lint、build 和 15 文件/692 项测试，确认不依赖 T6。
- T6 以独立提交记录 core 交付/纯模型投影、对应测试与契约/架构/规格。实现范围仍为上述 14 文件；提交收口另同步 README.md、docs/README.md 的任务进度，共 16 文件，不改变代码。
- T6 的准确暂存树也导出到独立临时目录，目标 Node 24.14.0/pnpm 10.33.2 下重新通过 typecheck、lint、build 和 17 文件/749 项测试；两个提交的阶段边界均已独立验证。
- README 中与阶段 03 集成说明相关的既有 hunk、research 原有修改和上级 plan.md 保留不提交。T5/T6 共享文件按任务边界拆分，原有 T5 adapter/测试内容保持不变。
