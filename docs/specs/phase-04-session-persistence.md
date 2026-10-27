# 阶段 04：会话保存与恢复

状态：`proposed`

规格日期：2026-10-27（Asia/Shanghai）。工作分支：`phase/04-session-persistence`。

用户已确认调研可以收口；本文件把[会话持久化调研报告](../research/session-persistence-research.md)第 9 章整理成可实施、可验收的规格，等待规格评审。本阶段尚未实现，不将调研中的类型检查和锁探针视为应用验收通过。

规格评审后转为 `designed`，开始实现时转为 `implementing`。格式、跨进程写者和恢复策略的理由见 [ADR-006](../decisions/ADR-006-session-persistence.md)，当前同为 `proposed`。现有阶段 01–03 的 accepted 契约仍描述已实现行为；本阶段实现必须同步更新受影响契约和架构，再经验证接受扩展。

## 1. 目标场景

用户在一个工作目录运行 `yucli`，完成普通问答或 `read_file` 工具往返后退出；重新启动进程，可以列出并恢复同一目录中的会话。下一次模型请求携带最近的完整成功历史和新问题。

进程在模型或工具执行期间中断时，保留已确认的执行事实。恢复能区分已取得的结果、已知异常、未开始和结果未知；不自动继续旧 turn、不重跑工具，也不把失败或半截对话送回模型。

完成标准包括保存成功的证据：完整结果和 `turn_end(success)` 都完成文件同步后，REPL 才提交历史。屏幕显示了文本不代表保存已经成功。

## 2. 范围

### 包含

- REPL 自动持久化，首次非空普通输入惰性创建会话；退出、重启、列表、显式恢复和 `/clear` 切换新会话。
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
| `yucli --resume <sessionId>` | 取得写入权、重新扫描并准备旧文件，成功后进入 REPL；失败不新建替代会话 |
| `/resume <sessionId>` | 仅在闲置 REPL 切换；成功准备候选后才关闭旧会话、替换历史 |
| `/clear` | 关闭旧会话并清空上下文，转回待创建；下次普通输入使用新 sessionId，旧文件保留 |
| `/exit`、`/quit`、EOF | 不再接受输入，完成已接受 turn 的收尾，关闭资源；正常退出 0 |
| 闲置 Ctrl+C | 关闭会话后退出 130；关闭失败则退出 5 |
| 活跃 Ctrl+C | 取消当前 turn；非成功终止保存确认后继续 REPL，存储失败则退出 5 |
| `/help`、空行 | 不发模型请求、不实体化新会话；帮助说明保存范围与 clear 的保留行为 |

三种模式 `--prompt`、`--sessions`、`--resume` 互斥；`--all` 仅能与 `--sessions` 使用。缺参、多余参数、空白 prompt、空白或不安全的 sessionId 为用法错误 2，在加载模型配置和创建文件前结束。REPL 内 `/resume` 缺参或非法时只报告用法，不把命令当普通问题发送；其他未知斜杠输入继续沿用原有普通文本行为。

v1 恢复选择要求完整 sessionId，不支持短前缀匹配或任意文件路径。短 ID 可用于列表显示，但必须同时提供可复制的完整 ID。身份须非空，且用于路径的 sessionId 限定为 1–128 个 ASCII 字母、数字、`_`、`-`，首字符为字母或数字；新建始终生成 UUID v4。日志中的教学占位身份可符合该安全字符规则，不以“不是 UUID”为由忽略其他校验。

显式恢复在首次新请求前向 stderr 报告 sessionId、已恢复成功 turn 数及中断/尾部处理摘要，不自动重印完整历史或工具内容；恢复空会话允许继续。正常新会话创建后在 stderr 给出完整 sessionId，方便后续选择。stdout 保持文本流、REPL 提示、命令帮助和用户主动请求的列表；不打印原始 JSON、SSE、工具参数或 reasoning。

启动参数检查在配置之前；`--sessions` 不调用模型配置加载器。新建/恢复 REPL 仍用启动环境加载 `.env` 和模型配置，配置失败为 3。新 REPL 的平台/锁能力预检不创建会话文件，避免接受首次问题后才发现平台根本不支持。

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

合法条目按 lastActivityAt 降序、createdAt 降序、sessionId 字典序排序。默认隐藏 header-only，报告隐藏数量；全局列表显示 empty。header 损坏而无法判定 cwd 的条目默认只计数，在全局诊断区显示文件位置与原因；损坏/不支持条目单列，不编造排序时间。单个坏文件不妨碍只读列出其他条目；目录读取等列表整体操作失败退出 5，成功展示含坏文件的诊断列表仍退出 0。

### 恢复、配置与切换

新会话 header.cwd 是启动目录的 realpath 绝对路径；恢复必须与当前规范化 cwd 完全相等。父子目录、不同 worktree、目录改名后的路径均不自动兼容；符号链接入口最终指向同一真实目录时允许。`read_file` 根目录使用该规范化 cwd，不根据日志切目录或加载另一项目凭证。

模型、端点、工具和 `.env` 使用当前启动环境；历史不控制当前配置。比较将进入上下文的最近成功 turn 的 runtimeProfile；无成功 turn 时回退最近 user。provider/model 不同时，在恢复完成后、首次新请求前向 stderr 提示旧值和当前值一次；纳入上下文的记录缺摘要则提示无法完整核对。提示不要求确认、不进入模型消息。相同 provider/model 不能解释为全部配置一致。

REPL 切换按“准备候选 → 关闭旧会话 → 替换会话与历史”执行。准备期间不接受新的模型输入，旧写者继续持锁；选择当前会话为无操作。busy、not_found、cwd_mismatch、corrupt、unsupported 等访问拒绝关闭候选资源后保留旧会话和历史，允许重试。候选修复、保存或关闭发生 PersistenceError，或锁服务不可用时，不再继续交互；关闭候选和旧会话后退出 5。旧会话关闭失败同样不能提交候选历史。

首次普通输入创建会话失败时不进入模型、不继续消费下一条问题，以 5 收尾退出；上述可重试规则仅适用于显式选择候选会话的访问拒绝，不把创建或保存故障当普通 turn 错误继续。

## 4. 调用链、模块与状态归属

```text
bootstrap/cli：参数分流、配置、cwd/时钟/UUID/锁/存储组装
  ├─ --sessions → SessionStore.list → 固定字节扫描和占用探测 → 列表
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
| bootstrap/repl.ts | 历史从空开始；catch 所有 turn 错误后继续；clear 仅清数组 | 接收恢复投影；只提交协调方确认结果；存储故障停输入并关闭；clear 与 resume 管理会话资源 |
| bootstrap/cli.ts | 两种模式提前加载同一配置，无列表/恢复分流 | 列表不加载模型配置；帮助、参数和平台检查按顺序完成；组合存储与退出监督器 |

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
| tool_end | `{callMessageSeq,toolCallId,name,outcome,error}` | 没有正常结果的异常终止，outcome 仅 failed/cancelled/timeout |
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

success 不带 error；其余 outcome 必须带匹配分类的 error。工具 timeout 只有实现明确执行期限后才可产生；本阶段不新增工具执行超时，不因枚举存在就宣称能抢占 Node 文件调用。保存故障属于 PersistenceError，不通过这些业务错误伪装写回故障文件。

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
type TurnEnd = { outcome: "success"; error?: never } | FailureEnd;
type CallRef = { assistantId: string; toolCallId: string; name: string };

type CoreTurnFact = { turnId: string } & (
  | { type: "assistant"; assistantId: string; message: AssistantMessage }
  | { type: "tool_start"; call: CallRef }
  | { type: "tool_result"; call: CallRef; result: ToolResult }
  | { type: "tool_end"; call: CallRef; end: FailureEnd }
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

header-only、创建失败产物、稳定锁文件及备份会累积。手动删除须在所有相关写者退出后离线进行：正文与 recovery 备份分别决定是否删除，锁文件可保留；不得在可能有持有者或并发打开者时 unlink 锁。未来删除/归档须另行设计锁、备份、目录同步和失败恢复，本阶段不实现。

## 9. 错误、退出码与恢复能力

新增 SessionAccessError（访问拒绝）和 PersistenceError（保存/修复/所有权/关闭故障），字段为安全 operation/code/message，可带 lastConfirmedSeq、行/字节位置；不回显未经整理的原始异常或正文。5 表示会话操作未完成，不等于一定丢失数据。

| 分类/code | 启动或当前进程行为 |
| --- | --- |
| SessionAccessError：session_busy、not_found、cwd_mismatch、unsupported、corrupt、invalid_identity、permission_denied | 启动恢复退出 5；REPL 候选访问拒绝则释放候选、保留健康旧会话并允许重试 |
| SessionAccessError：platform_unsupported | 创建/恢复预检无持久化副作用地退出 5 |
| SessionAccessError：lock_unavailable | 与 busy 区分；启动退出 5，REPL 停止新的持久化执行并关闭退出，不降级 |
| PersistenceError：write_failed、sync_failed、repair_failed、ownership_lost、close_failed、contract_violation、io_timeout | 停止新执行/输入，不递归写终止；关闭或按应急期限结束，退出 5 |
| 模型/工具普通失败、取消、超时 | 非成功 turn_end 确认后沿用阶段 03：REPL 继续，单次模式返回 4 |
| 参数/配置失败 | 保持 2/3，不创建会话或发请求 |
| 正常退出/闲置取消 | 资源关闭成功时为 0/130；保存或关闭故障优先为 5 |

执行中保存失败即使同时观察到取消，也保留原 PersistenceError，不能改写为 AbortError、protocol_error 或 tool_result(ok:false)。访问阶段权限不合规为访问拒绝；已持有 writer 后 I/O/所有权变化是存储故障，不能被 REPL 的宽泛 catch 吞掉。

## 10. 设计选择与参考依据

| 决策 | 本阶段采用 | 备选及未采用原因 |
| --- | --- | --- |
| 历史真相与读模型 | 单文件追加 JSONL；严格校验后投影完整成功 turn | JSON 消息数组易覆盖且不表达执行边界；SQLite/索引扩大查询、迁移与依赖范围 |
| 工具数据 | assistant 内保存调用，独立 result 保留 ok，start/end 表达生命周期 | 单存 ToolMessage 丢 ok；再存 tool_call/tool message 会重复事实 |
| 保存确认 | 每个业务屏障完整写入和文件同步，创建同步目录 | 后台接受/普通 flush 边界较弱；合并同步优化待测量，不能越过副作用屏障 |
| 写者 | 稳定 sidecar 的非阻塞内核锁，fs-ext@2.1.1 | mkdir 崩溃后需人工清理；心跳可能抢占暂停进程，不满足自动接管语义 |
| 恢复 | 同 cwd、严格拒绝整个损坏文件、仅修复可证明未完成尾部 | 跳过坏行会伪造合法历史；自动补结果或续跑会误判外部执行 |
| 模型历史与 clear | 最近 20 个完整成功 turn；clear 新建会话 | 失败 user 留在模型可能与新问题一起回答；原文件 context_reset 增加格式机制 |
| 配置与模式 | 当前启动配置，user 外层仅 provider/model；REPL 保存、单次不保存 | 历史配置可能带凭证/过期策略；指纹及所有脚本自动保存扩大 v1 范围 |
| 资源与清理 | 无记录字节硬上限、无索引分页、完整备份保留，操作有明确期限 | 上限需写读共同设计；自动删除与修复恢复需要独立所有权协议 |

借鉴 Pi 的可读日志与惰性创建、DSH 的存储契约和所有权、Codex 的写者与保存屏障分工、ZCode 的核心端口及恢复投影。没有复制参考项目的树 UI、后台队列、SQLite 或宽容跳行；它们的同步 append/flush 也不作为本规格 fsync 保证的证据。参考源码和快照依据保留在调研报告，不在规格重复整份调研。

## 11. 实现任务清单

按依赖顺序交付，每项完成必须在“实际结果”写明代码、验证和限制。不得在执行前把所有任务勾成完成。

- [ ] **T1 规格与契约**：评审本规格和 ADR-006；新增 docs/contracts/session-store.md，固定格式、接口、扫描结果、错误与生命周期；CLI/REPL/tool-execution 契约登记阶段 04 draft 扩展，更新 architecture、文档入口和 legacy-paths 的实际影响。
- [ ] **T2 依赖与锁**：以 optionalDependencies 固定 fs-ext@2.1.1，在目标 Node/平台验证实际安装、构建/CI 工具链和按需加载；实现稳定锁、占用探测和进程内登记，重复应用级双进程互斥、暂停、关闭与 SIGKILL 验证，禁止静默回退。
- [ ] **T3 格式与扫描**：新增 contracts/session.ts 业务类型/错误、adapter JSONL schema/语义校验与字节扫描、JSON/UTF-8 前缀识别器；完整覆盖合法组合表和诊断位置。
- [ ] **T4 文件与 writer**：实现目录/身份/权限、wx 创建、短写与 sync、seq/assistantId 映射、失败状态及 close；新增可控 I/O/时钟注入，不引入生产假模型客户端。
- [ ] **T5 恢复与修复**：持锁重新扫描、完整备份及清单同步、修改前复核、truncate/补 LF/重验、成功 turn 快照和纯模型投影；失败不发模型请求、不自动重放。
- [ ] **T6 core 交付**：调整 runTurnStream、executeToolBatch、RegisteredTools 的逐项事实与结果取消边界；新增纯 ToolResult→ToolMessage 转换与 ToolExecutionError，保持整批预检、顺序、额度和兼容路径。
- [ ] **T7 协调与退出监督**：新增 runPersistentTurn，唯一 user/turn_end、保存确认提交凭证、PersistenceError 穿透；实现 30 秒操作等待、5 秒故障收尾和组合根应急退出。
- [ ] **T8 CLI/REPL**：分开列表/单次/恢复，新建惰性保存、resume/clear、列表字段/排序/状态、配置差异提示、安全输出与退出映射；故障后停止消费管道中的后续问题。
- [ ] **T9 集成验收**：运行第 12 节矩阵及项目类型、Lint、构建和全套测试；源码/构建产物 CLI、锁与故障子进程均覆盖；完成目标环境的人工重启/恢复检查。
- [ ] **T10 文档与完成审查**：按实测结果更新本文件、README、architecture、契约与依赖说明；报告保留限制和未验证环境，审核中文注释、Git diff 和阶段分支。只有验证完成才转 verified，用户审查后再转 done/申请集成。

规划新增模块为 contracts/session.ts、core/runPersistentTurn.ts、core/sessionHistory.ts、core/toolMessage.ts，以及 adapters/session 下的 store/writer/scanner/repair/lock/prefix 组件；具体文件拆分可随实现规模合并，但职责、依赖方向和验收不能省略。bootstrap 可新增小型会话生命周期/退出监督模块，不把业务过程堆入参数解析器，不新建事件总线、插件平台或未使用抽象。

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
| A07 | clear 后新输入、显式再打开旧会话 | 新 ID/文件、下一请求无旧上下文；旧文件可恢复；clear 关闭失败不进入新会话 |
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

- 会话持久化调研与逐项讨论收口；规格首稿、proposed ADR 和实现/验收任务已整理。
- 既有代码阅读确认了中途交付、结果取消、错误分类和 REPL 继续行为的调整范围；生产源码、依赖和 accepted 契约尚未修改。
- 调研期间 fs-ext@2.1.1 已在隔离目录、macOS arm64 + Node 24.14.0 验证安装、双进程互斥、异步 exnb、只读 shnb、暂停保护、描述符关闭/SIGKILL 释放及目录同步调用；证据范围见调研报告 9.5。项目内安装、CI 与应用集成仍待 T2/T9。

### 本轮验证与未完成项

本轮通过文档检查：13 节结构、10 个未完成任务、34 个唯一验收编号、相关文档 54 个本地链接，以及两个完整 JSONL 示例的 JSON、连续 seq、调用引用和终止组合；调研正文保持不变，仅更新收口状态和规格入口。

另将规格类型提取至临时 .mts，引用现有 message/tool/agent 类型，使用项目 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes 等选项执行 `tsc --noEmit`，校验通过；这只验证声明兼容性，不等于已实现存储接口或通过项目全套检查。本轮未运行 pnpm typecheck/lint/test 或真实模型请求，未执行尚未实现的运行时验收。T1–T10 均未标完成，声明检查不能替代保存屏障、取消竞态或错误穿透测试。

下一步先评审此 proposed 规格，重点看新固定的 30 秒操作等待/5 秒故障收尾、完整 ID 选择和恢复接口。评审通过后同步 draft 契约、接受 ADR 并按 T1–T10 实现。阶段完成后仍停在阶段分支；向 main 集成、推送或打标签须用户另行授权。
