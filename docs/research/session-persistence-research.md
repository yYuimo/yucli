# 阶段 04：会话持久化调研报告

状态：`research-draft`

调研日期：2026-10-20（Asia/Shanghai）

补充日期：2026-10-20（Asia/Shanghai）

变更记录：补正参考快照 commit；补充单写者、落盘成功语义、v1 事件/replay、目录恢复、版本/未知事件、坏行、隐私保留和失败 turn 边界；扩充评审问题。

评审修订：2026-10-25（Asia/Shanghai）。统一文件 header 与扁平目录方案；补明失败 turn 的上下文投影、恢复修复事件、`eventId` 用途和目录/权限/删除范围，作为后续规格的推荐决策。

讨论重置：2026-10-26（Asia/Shanghai）。按用户要求清空第 9 章正文，逐步讨论 yucli 的数据结构与选型；数据结构包括实际 JSONL 文件的 header、逐行记录、字段及完整文件示例。其他章节保留参考项目调研与此前的初步判断，其中对 yucli 的取舍均待重新讨论确认。

生命周期讨论：2026-10-26（Asia/Shanghai）。补写 9.3 的 turn/tool 事件、错误与恢复校验，9.4 的保存确认屏障，以及 9.5 的文件、写者与关闭边界。

闭环评审修订：2026-10-26（Asia/Shanghai）。补齐列表状态、运行配置差异与模式/错误边界；新增 9.6 字节扫描和备份修复算法、9.7 有序业务事件接口，并记录隔离锁验证的实际结果与平台限制。

范围收敛：2026-10-27（Asia/Shanghai）。将 runtimeProfile 简化为 provider/model 并贯通 user TurnFact；明确分派前取消、尾部/列表状态映射及 v1 已验证平台范围，9.8 汇总五项推荐决策。

本报告只用于技术选型评审。本次没有修改 `src/`、没有创建阶段规格、接口契约或 ADR，也没有开始阶段 04 实现。

## 1. 调研范围和资料状态

本次围绕四个问题阅读参考项目：

1. 会话和消息以什么形式保存。
2. 一次用户输入、模型输出和工具调用在什么时机写入。
3. 新进程如何 resume，以及崩溃或半截 turn 如何处理。
4. 历史变长后如何做 compaction，同时保持恢复能力。

参考项目：

| 项目 | 本地位置 | 快照 commit | 资料状态 |
| --- | --- | --- | --- |
| Pi | `agent-lab/references/pi` | 快照待补 | 工作区可读；重点阅读 coding-agent 的 JSONL session、SessionManager 和 compaction |
| ZCode | `agent-lab/references/zcode` | `aac4755` | 官方来源记录为 `aac4755666d09fdcd70272fcf063c077a639015f`；重点阅读 session-persistence 设计、SQLite store、message/part 和 history hydration |
| DSH | `agent-lab/references/dsh` | `5badb15` | 官方来源记录为 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`；重点阅读 session-format、persistence catalog、版本迁移和 storage contract |
| OpenAI Codex CLI | `agent-lab/references/codex` | `4be9cfd` | 工作区当前快照为 `4be9cfd`；重点阅读 Rust rollout recorder、resume、压缩、索引和状态数据库 |
| OpenCode | `agent-lab/references/opencode` | `d814879` | 工作区当前快照为 `d814879`；重点阅读 SQLite session、durable event、projector、history 和 compaction |

当前 `yucli` 阶段 03 已完成并提交；本报告不改变它的流式 REPL 和内存历史行为。

## 2. 先给结论

这几个项目并没有一个可以直接复制的“会话表”。它们分别解决不同规模的问题：

- **Pi** 把会话做成易读的 append-only JSONL 树，适合单机 CLI、分支和学习。
- **Codex CLI** 把 rollout 做成更严格的 JSONL 持久化日志，再用 SQLite 做列表、索引和状态投影；它重点解决后台写入、并发、压缩、恢复和迁移。
- **DSH** 把格式版本、事件 envelope、相邻迁移和持久化目录当成长期兼容性边界，适合学习“格式一旦写出就必须维护”。
- **ZCode** 把 `session`、`message`、`part` 放进 SQLite，并把运行态、历史、UI 投影和恢复逻辑分开，适合查询、流式更新和复杂工具状态。
- **OpenCode** 在 SQLite 上进一步采用 durable event + projector：事件负责写入事实，projector 负责维护当前 session/message 视图；它还把 pending input、execution claim、compaction 和 resume 放进统一的生命周期模型。

对当前的 yucli，推荐的方向是：**先采用 Pi/Codex 风格的单文件 append-only JSONL，加入 DSH 的显式版本和事件 envelope，暂时不采用 ZCode/OpenCode 的完整 SQLite、事件总线和 projector 体系。**

这个选择能满足阶段 04 的学习目标：退出后恢复同一段对话、保留工具往返、识别未完成 turn、为以后 compaction 留出边界，同时不把数据库迁移、查询索引、事件投影和进程级调度一起引入。

SQLite 不是被否定的长期方向。等 yucli 需要按工作目录搜索会话、分页浏览、并发进程、归档/删除、复杂查询或多个客户端共享状态时，再把存储实现替换为 SQLite；届时应保留上层 `SessionStore` 抽象，并用迁移工具保护已有 JSONL 数据。

## 3. Pi：可读的 JSONL 树和上下文投影

### 3.1 物理格式

Pi 的会话文件位于按工作目录分组的目录中：

```text
~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session-id>.jsonl
```

第一行是 `session` header，后续每行是一个带 `type`、`id`、`parentId` 和时间戳的 entry。当前格式版本为 v3，加载旧文件时会在内存中迁移 v1 → v2 → v3；如果迁移改变了文件内容，SessionManager 会重写文件。

当前 entry 不只有消息，还包括：

- `message`：user、assistant、toolResult、system 等消息。
- `model_change`、`thinking_level_change`：会话状态变化。
- `usage`：不进入模型上下文的成本/token 记录。
- `compaction`：摘要、保留边界和压缩时的 system/tool checkpoint。
- `context_edit`：追加式地删除或替换未来模型上下文中的某一条记录。
- `branch_summary`：离开分支时记录的摘要。
- `custom`、`custom_message`、`label`、`session_info`：扩展状态和 UI 元数据。

原始文件保留全部 entry；模型看到的消息由当前 leaf、分支、context edit 和 compaction 重新投影得到。也就是说，持久化历史和当前模型上下文是两个不同概念。

参考：

- `references/pi/packages/coding-agent/docs/session-format.md`
- `references/pi/packages/coding-agent/src/core/session-manager.ts`

### 3.2 保存时机

Pi 的 SessionManager 维护内存中的 `fileEntries`、`byId` 和 `leafId`。

每次 `appendMessage`、`appendCompaction` 或其他 `append*` 操作都会：

1. 追加 entry 到内存数组。
2. 更新 ID 索引和当前 leaf。
3. 调用 `_persist`。

新会话不会因为只设置模型、思考级别或 system 状态就创建文件。第一次出现 user 或 assistant 消息时，SessionManager 一次性写入 header 和已有 entry；之后每个 entry 追加一行。这样既避免空会话文件，也能保证用户 prompt 在模型尚未回答前已经落盘。

当前实现使用同步文件写入，简单但会阻塞调用线程；它的优点是保存边界非常直观。

### 3.3 resume、分支和 compaction

`--continue` 选择当前工作目录最近的会话，`--resume` 打开会话选择器。读取文件时逐行解析，坏行会被跳过；header、版本迁移和会话索引仍需通过校验。

Pi 的分支只改变当前 `leafId`，已有 entry 不删除；新 entry 的 `parentId` 指向选定节点。`/fork` 或 `createBranchedSession` 可以把一条路径复制到新文件，并保留 `parentSession` 关系。

Compaction 不删除旧记录，而是追加一个 `compaction` entry：

- `summary` 保存旧上下文的摘要。
- `firstKeptEntryId` 标记要保留的尾部起点。
- `systemMessage` 保存压缩边界处完整的 system/tool 状态。
- 重建上下文时用摘要替换更早历史，再拼接保留尾部和压缩后的新消息。

这给 yucli 的直接启发是：**持久化文件应保留原始事实，模型上下文由 replay/投影决定；compaction 是一个边界事件，而不是删除历史文件。**

## 4. OpenAI Codex CLI：rollout JSONL、后台写入和恢复边界

### 4.1 rollout 文件和索引

Codex CLI 的 rollout 是 JSONL 文件，默认放在 `codex_home/sessions/`，归档文件放在 `archived_sessions/`。文件名携带时间、thread ID 和 rollout ID；revert 或 fork 可以为同一个 thread 生成新的 immutable rollout 文件。

第一条记录通常是 `SessionMeta`，后续记录是 `response_item`、`event_msg`、`turn_context`、`world_state`、`token_usage_record`、`Compacted`、`RetainedContext` 等。记录有 ordinal 时，ordinal 可以从 `history_base.end_ordinal_exclusive` 继续，支持引用父 rollout 的历史边界。

Codex 还维护 State DB，用于会话列表、元数据、归档和回填；它不是模型历史的唯一真相源。rollout 文件仍然能独立解析和恢复。

参考：

- `references/codex/codex-rs/rollout/src/lib.rs`
- `references/codex/codex-rs/rollout/src/recorder.rs`
- `references/codex/codex-rs/rollout/src/metadata.rs`
- `references/codex/codex-rs/rollout/src/list.rs`

### 4.2 保存时机和写入可靠性

`RolloutRecorder` 有两种创建路径：

- 新会话先计算文件路径和 metadata，可以延迟到显式 `persist()` 才创建文件。
- resume 会立即打开已有 rollout 以追加。

记录先进入异步 writer task 的 bounded channel，再由 writer task 顺序写文件。`persist()` 负责 materialize 文件并写入 pending items；`flush()` 等待排队写入完成；`shutdown()` 在停止前 drain pending items。写入失败时，pending items 保留在内存中，后续 `persist()` 或 `flush()` 可以重试。

这比 Pi 的同步 append 复杂，但解决了三个实际问题：调用线程不阻塞、多个调用者不会同时操作文件、写入失败不会静默丢掉尚未落盘的记录。

Codex 还支持 `.jsonl.zst` 压缩文件。读取器透明处理 plain/compressed 两种物理表示；追加前需要安全地 materialize 回 plain JSONL，并使用 writer lock、临时文件、flush/sync 和无覆盖发布，避免压缩和追加互相破坏。

### 4.3 resume 和半截记录

resume 通过 thread/rollout 元数据定位文件，再调用 `load_rollout_items` 逐行读取：

- 空白行跳过。
- JSON 解析失败的行计入 `parse_errors` 并继续读取。
- 首个 `SessionMeta` 提供 canonical thread identity。
- 读取结果保存 `rollout_path`、conversation ID 和完整 item 列表。

恢复不是简单地“取最后几条消息”。Codex 会根据最新的 compaction、history mode、history base、turn context 和 fork/revert 边界重建当前模型历史。未完成 turn、旧 rollout、父 rollout 和子 agent 的关系都通过显式记录表达。

### 4.4 compaction

Codex 的 `CompactedItem` 可以携带 replacement history、window number、resume metadata 和 retained context。读取模型上下文时从文件尾部向前扫描；找到同时具有 replacement history 和 window number 的最新 compaction 后，可以只恢复其后的 bounded suffix。缺少关键字段的旧 compaction 会强制 full replay，不能错误地在更旧的 checkpoint 停止。

此外，Codex 会将 tool output 在接近 context 上限时替换为固定的截断提示，而不是悄悄删除整条 tool call 关系。这个思路对 yucli 很有价值：**大工具结果的压缩必须保留 call/result 结构，并明确标记内容已被裁剪。**

## 5. DSH：格式版本、事件 envelope 和相邻迁移

DSH 的重点不是某一种数据库，而是把 Session 格式当成长期兼容协议维护。

### 5.1 格式和事件

DSH 的 session format 由 header、event envelope 和 event payload 组成。envelope 包含 `type`、`seq`、`time`、`data`，还有可选的 `ignorable`、`surfaceOp` 和 `sourceEventSeqs` 等字段。事件分为会产生模型历史的 surface event 和只用于日志/审计的 log-only event。

仓库会生成 persistence catalog，列出每个持久化事件、解析类型和类型指纹；格式版本有独立的定稿记录和发布记录。

参考：

- `references/dsh/docs/persistence-catalog.zh.md`
- `references/dsh/docs/session-format-status.zh.md`
- `references/dsh/packages/session/session-format/README.zh.md`
- `references/dsh/packages/session/session-format/src/chain.ts`

### 5.2 迁移策略

DSH 要求迁移是相邻的 `vN → vN+1`，迁移链必须完整、唯一、可验证。读取旧格式时先判断 header，再按流式方式转换事件；不能跳过中间版本，也不能把新版本静默当成旧版本读取。

这和 yucli 当前规模不匹配，完整迁移目录暂时过重，但两个原则应该保留：

1. 写入文件必须带明确的 `formatVersion`。
2. 一旦阶段 04 写出文件，后续变更不能直接重解释旧字段；应提供显式迁移或明确拒绝恢复。

### 5.3 对 yucli 的启发

DSH 的价值在于“格式治理”而不是“直接复制所有事件”：每个事件的公开字段、可忽略性、顺序和迁移责任都应该有记录。阶段 04 可以先采用一个小型 envelope 和一个 `formatVersion: 1`，将未来迁移留在存储边界内。

## 6. ZCode：SQLite 的 session/message/part 分层

ZCode 的会话持久化设计明确拒绝把所有内容塞进一条大 JSON 或一个 operation journal。核心是三层：

```text
session  →  message  →  part
```

- `session` 保存目录、标题、模型选择、归档、revert 和更新时间等会话级元数据。
- `message` 保存 user/assistant 的生命周期、模型、成本、token、错误和完成时间。
- `part` 保存 text、reasoning、tool、patch、snapshot、compaction、retry 等内容块。

流式文本和工具状态更新同一个 part，而不是每个 token 新建一行；message/part 的阶段性写入放入事务。运行态 `SessionRunState` 只在进程内保存，重启后从已持久化 message/part 判断是否有半截 assistant 或未完成 tool。

ZCode 的 resume 顺序是：读 session → 按稳定时间/ID 顺序读 message → 按 message_id 读 part → 拼回 `MessageWithParts` → 由 history hydrator 重新生成 provider-visible context。UI timeline 的 `session_entry` 是投影缓存，不是模型历史唯一来源。

它对工具和崩溃恢复的处理很具体：

- tool part 有 `pending → running → completed/error` 状态。
- resume 遇到未完成 tool，会注入“工具执行在恢复前被中断”的结果，不会无条件重复执行外部副作用。
- completed tool 结果同时保存 UI/display 数据和模型可见内容布局；旧数据缺少新字段时回退到 legacy output。
- 输入、消息、part 和 compaction 的写入边界需要和 runtime 事件保持一致。

参考：

- `references/zcode/apps/zcode-cli/docs/design/v2/session-persistence.md`
- `references/zcode/apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
- `references/zcode/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`
- `references/zcode/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`

## 7. OpenCode：SQLite + durable event + projector

OpenCode 当前 v2 session 体系比 ZCode 更强调事件驱动和运行生命周期。

### 7.1 事实、投影和查询

OpenCode 使用 SQLite/Drizzle，`session_v2` 保存 session 元数据，`session_message` 保存按 `seq` 排序的消息行，消息业务内容放在 JSON `data` 中；另有 `session_inbox` / pending 表保存尚未 delivery 的用户输入和控制项。

`SessionEvent` 是 durable event。`SessionProjector` 将事件投影为 session/message 当前状态：消息创建时 insert，assistant、shell、compaction 在运行过程中 update，终止事件再写 idle/outcome。所有消息从同一个 schema 解码，旧数据在 decoder 边界做兼容升级。

这和纯 append-only JSONL 的区别是：OpenCode 同时保存“发生过什么”和“当前可查询状态”，从而支持列表、分页、消息查询、运行状态和 UI 更新；代价是 event、projector、数据库事务和 schema migration 都必须保持一致。

### 7.2 prompt admission 和 resume

OpenCode 先把 prompt 写入 durable inbox，再由 runner delivery 成可见 user/synthetic message。`resume` 控制是否调度执行，不决定是否持久化输入。Session execution 使用 process-local coordinator，但 `time_suspended` / resume attempts 等 claim 状态写入数据库，用于重启后发现未完成执行。

恢复后的 session 不会假设旧进程还存在；它从 durable message、pending input、execution claim 和 location 信息重新决定是否继续。这个模型适合多客户端和后台 session，但对当前 yucli 来说明显超出单进程学习范围。

### 7.3 history 和 compaction

OpenCode history reader 以最新 completed compaction 为边界：

- summary compaction 保存 summary 和 `keepID`，读取时从数据库重建最近保留文本。
- native compaction 保存 provider-specific `native.messages`，只在兼容同一 provider/model 时重放。
- 无法重放的 native checkpoint 会退回 checkpoint 之前的历史，而不是直接让 session 无法读取。
- 运行中的 assistant/compaction 不作为已结算历史；preview 只读取 settled prefix。

参考：

- `references/opencode/specs/v2/session.md`
- `references/opencode/packages/core/src/session/sql.ts`
- `references/opencode/packages/core/src/session/projector.ts`
- `references/opencode/packages/core/src/session/history.ts`
- `references/opencode/packages/core/src/session/compaction.ts`
- `references/opencode/packages/schema/src/session-message.ts`

## 8. 方案比较

| 维度 | Pi JSONL 树 | Codex rollout JSONL | DSH 事件格式 | ZCode SQLite | OpenCode SQLite + projector |
| --- | --- | --- | --- | --- | --- |
| 主要目标 | 单机可读、分支和 resume | 可靠 rollout、后台写入和压缩 | 长期格式兼容 | 流式消息/工具和查询 | 多客户端、事件驱动和运行恢复 |
| 主要真相源 | append-only session file | rollout file；State DB 做索引 | versioned event log | message + part | durable event + projected tables |
| 写入方式 | entry 追加 | bounded writer task + flush | envelope/event writer | SQLite transaction + part update | event publish + projector transaction |
| 分支/父子 | entry tree、fork file | fork/revert rollout、history base | event lineage/sequence | parent/fork session | parent/fork session + inbox boundary |
| resume | 读文件并做 context projection | 读 rollout、识别 compaction/fork 边界 | 读 header、迁移 event | message/part hydration | session/message/history/projector 恢复 |
| 半截 turn | 原始 entry 留存，按路径投影 | parse errors、turn/compaction metadata | 事件状态和版本规则 | assistant/tool 未完成状态 | execution claim、running message、inbox |
| compaction | summary + firstKeptEntryId | replacement history + bounded suffix | 格式/事件迁移边界 | compaction part + hydrator | summary/native checkpoint + model boundary |
| 复杂度 | 低 | 中高 | 中高 | 高 | 很高 |
| 适合当前 yucli | 高 | 中高，择其可靠性部分 | 高，择其版本治理部分 | 暂不适合完整引入 | 暂不适合 |

## 9. 对 yucli 的技术选型建议

### 9.1 数据结构讨论（一）：JSONL 文件的外层结构

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选草图，尚未确认**。

本节从实际文件内容出发说明外层结构；普通问答是入门示例，完整候选格式还包括 9.2–9.3 的工具与终止事件、9.5 的运行配置摘要、9.6 的恢复扫描，以及 9.7 的业务交付接口。各节均为调研候选，确认后再整理成阶段规格。

#### 为什么选择带类型的记录

JSONL 规定每个物理行是一个独立的 JSON 值。这里建议每行都使用对象，以 UTF-8 编码；记录之间用换行分隔，每条记录末尾包含换行，字符串内容中的换行通过 JSON 的 `\n` 转义保存。整个文件不加外层数组，记录之间也不加逗号。

需要先比较两种数据形态：

| 形态 | 每行保存什么 | 能表达什么 |
| --- | --- | --- |
| 纯消息记录 | `{ "role": "user", "content": "你好" }` 等消息对象 | 能还原消息顺序；会话身份和 turn 是否完成还需要其他结构表达 |
| 带类型的记录（本轮推荐） | 用 `type` 区分会话信息、消息和 turn 终止记录 | 同一文件能表达消息内容与执行边界；恢复时需要按记录类型解释 |

推荐第二种，原因是一次用户提问可能包含多次模型调用和工具往返，也可能中断；持久化需要表达这些消息属于哪次提问，以及执行是否已经结束。采用这种记录形态不要求同时引入事件总线或数据库投影系统。

#### 一个无工具普通问答的完整 JSONL 示例

以下四行是无工具问答的完整业务记录，使用 UTC ISO 8601 时间与便于阅读的占位 ID；真实 ID 生成见 9.5。为突出外层结构，本节及后续已有示例省略可选的 runtimeProfile；9.5 补充其格式，新写入器必须记录，缺失时读取器只能报告历史提供方/模型未知。

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"你好"}}
{"seq":2,"type":"message","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"你好！"}}
{"seq":3,"type":"turn_end","timestamp":"2026-10-26T02:00:03.100Z","turnId":"turn-1","payload":{"outcome":"success"}}
```

逐行含义：

1. 第一行说明“这是什么格式、哪段会话、从哪个工作目录创建”。
2. 第二行记录用户说了什么，并关联到 `turn-1`。
3. 第三行记录模型回答，同样属于 `turn-1`。
4. 第四行记录该 turn 已成功结束。它是执行状态，不是要发给模型的一条聊天消息。

这里一个 turn 指一次用户提问及其后续执行，可以包含多次模型请求。示例采用完整消息粒度；工具事件见 9.2–9.3，保存时机与同步屏障见 9.4。

#### header 与后续记录的字段

第一行 header 的候选字段：

| 字段 | 作用 | 本草图的约定 |
| --- | --- | --- |
| `type` | 告诉读取器这是会话头 | 值为 `session_meta`，只出现在第一行 |
| `formatVersion` | 确定整个文件按哪一版格式解释 | 示例为 `1`；本草图放在 header，后续行不重复 |
| `sessionId` | 标识会话，供定位和恢复使用 | 跨进程保持；9.5 推荐使用 UUID v4 |
| `createdAt` | 会话创建时间 | 示例用 UTC ISO 8601 字符串 |
| `cwd` | 创建会话时的工作目录 | 保存 realpath 绝对路径；恢复时按 9.5 与当前目录相等比较 |

后续记录的候选公共字段：

| 字段 | 作用 | 本草图的约定 |
| --- | --- | --- |
| `seq` | 确定记录顺序，帮助检查缺失、重复或倒退 | header 后从 `1` 开始连续递增；重复、缺口或倒退的处置见 9.3 校验表 |
| `type` | 说明这行属于哪种记录 | message、tool_start、tool_result、tool_end、turn_end；本节示例只用其中两种 |
| `timestamp` | 记录创建时间，便于展示与诊断 | 顺序仍由 `seq` 表达，不能依赖系统时钟排序 |
| `turnId` | 把同一次用户提问的相关记录关联起来 | `turn-1` 的消息和结束记录使用相同值 |
| `payload` | 保存该类型的业务数据 | `message` 保存消息对象，`turn_end` 保存执行结果 |
| `runtimeProfile?` | 接受 turn 时的配置摘要 | 仅 user 记录使用；读取允许缺失并标未知，新写入要求提供，见 9.5 |

`type` 和 `payload.role` 分别回答“这是一条什么记录”和“消息是谁发出的”。例如 `type: "message"` 的 payload 可以是 user 或 assistant 消息；`type: "turn_end"` 的 payload 没有消息角色。该分工可以沿用现有 `Message` 的 `role`、`content` 字段，再由存储外层补充顺序、时间和 turn 归属。

#### 读取时怎样使用

读取第一行恢复会话基本信息，再按顺序解释后续记录：`message` 提供消息内容，`turn_end` 提供 turn 完成边界。恢复器据此构造模型所需的 `Message[]`，header 和结束记录各自用于元数据与状态处理。

恢复投影遵循 9.3：只有完整成功 turn 进入下一次模型上下文，失败和中断记录仅供展示/诊断。9.6 具体化扫描与续写准备，9.7 具体化运行时交付及历史提交。

本章当前候选采用“会话头 + 带类型的记录”，工具往返见 9.2，合法组合见 9.3。v1 不引入 eventId 去重或 parentId 分支；9.7 的 assistantId 是 turn 内临时业务身份，不新增磁盘消息 ID。

### 9.2 数据结构讨论（二）：工具调用与结果的持久化

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选设计，尚未确认**。

本节对照现有类型和实际转换代码，讨论工具往返怎样落在 9.1 的 JSONL 结构中。重点是保存完整调用和已交付的执行结果；生命周期和异常记录在 9.3 继续讨论，具体落盘可靠性机制在后续小节展开。

#### 现有四个类型分别表示什么

`Message` 是 `TextMessage | AssistantMessage | ToolMessage` 的联合，用于模型历史；它本身没有统一的运行状态字段。`ToolCall` 是 assistant 提出的调用数据；`ToolResult` 是本地注册表交付的执行结果；`ToolMessage` 是根据该结果生成的模型历史消息。

不能按“在运行时创建”就把字段归为无需保存。这里要区分两类状态：已经发生的结果事实，例如 `ok`；正在执行时使用的临时控制状态，例如 AbortController、文件句柄或未完成的流式参数缓冲。

| 现有类型与字段 | 含义及来源 | 持久化建议 |
| --- | --- | --- |
| `TextMessage.role` / `content` | user/system 文本及角色；当前 CLI 不自动创建 system 消息 | 保存实际存在的消息，保留文本原文 |
| `AssistantMessage.role` / `content?` | 模型角色及可选文字；有工具调用时也可以同时有文字 | 保存；保留可选语义和原文，不把含调用的文本误当最终回答 |
| `AssistantMessage.toolCalls?` | 模型提出的完整有序调用列表 | 随该条 assistant 消息保存，保持顺序 |
| `ToolCall.id` | 模型给出的调用 ID；同一批内非空且唯一 | 保存原值，结果配对时沿用 |
| `ToolCall.name` | 请求的工具名称 | 保存原值；非空但未注册的名称也能产生可恢复工具错误 |
| `ToolCall.argumentsJson` | 非流式返回或流式拼装完成后的参数 JSON 文本 | 保存字符串原文；JSONL 序列化会转义其中的引号，不额外保存一份解析后对象 |
| `ToolResult.toolCallId` | 对应 `ToolCall.id` | 保存原值 |
| `ToolResult.name` | 注册表从调用补入的工具名 | 保存；用于本地诊断和配对校验，当前 HTTP adapter 不发送该字段 |
| `ToolResult.ok` | 工具成功或可恢复工具错误的已交付结果 | **保存**；这是执行结果事实，不能因模型消息没有该字段而丢弃 |
| `ToolResult.content` | 文件原文或安全错误摘要；空文件可以成功返回空字符串 | 保存原文；恢复历史使用保存的内容，不重新读文件 |
| `ToolMessage.role` | 固定为 `tool` 的模型消息标签 | 恢复时根据 `tool_result` 生成 |
| `ToolMessage.toolCallId` / `content` | 从 ToolResult 复制的调用 ID 和模型可见文本 | 从已保存结果派生，避免再保存一行重复结果消息 |
| `ToolMessage.name?` | 可选的本地工具名；当前 core 创建消息时填入 | 从已保存的 `ToolResult.name` 派生；当前 HTTP adapter 省略它 |

上述字段主要都是消息/结果数据；四个类型中没有 Promise、文件句柄、定时器或取消控制器。`readonly` 和可选字段标记属于 TypeScript 类型约束，不是额外 JSON 字段。流式 assembler 的 index、Map、参数片段和 ended 标记等属于当前响应的拼装状态；本轮候选格式保存拼装后的完整调用。

#### `ToolResult.ok` 为什么需要单独保留

当前实际流程为：

```text
Tool.execute 返回 {ok, content}
  → RegisteredTools 补入 toolCallId、name，得到 ToolResult
  → runTurnStream 将完整 ToolResult 加入 toolResults
  → 同时构造 ToolMessage，加入 appendedMessages
  → HTTP adapter 把 ToolMessage 转成 role、tool_call_id、content
```

`ok` 保留在 `toolResults` 中，没有进入 `appendedMessages` 的 tool 消息。它的缺失表达了模型消息与本地执行结果的职责不同；当前请求协议靠 tool 消息的 content 向模型表达文件错误。

保存时应保留 `ok`，供恢复后的展示和诊断使用；构造模型消息时继续遵循现有 ToolMessage 契约。不能通过 `content` 是否为空或是否以 `[file_not_found]` 等文字开头来反推 `ok`：空文件是成功，真实文件内容也可能恰好包含错误提示文字。

`ok: false` 只表示注册表正常交付了一个可恢复工具错误，**不等于整个 turn 失败，也不表示取消或崩溃**。取消、参数/协议错误和不可恢复内部异常在当前实现中走抛异常路径，没有对应的正常 ToolResult；不能据此伪造一条 `ok: false` 的“已完成结果”。

#### 建议的记录划分

| 内容 | JSONL 记录 | 设计理由 |
| --- | --- | --- |
| user/system 文本、assistant 文本及调用列表 | `type: "message"`，payload 保存对应消息 | 工具请求仍属于 assistant 的一次响应；同时出现的文字和多个调用保持在同一条消息中 |
| 已交付的工具结果 | `type: "tool_result"`，payload 保存完整 ToolResult 与调用消息引用 | 保留 ok、名称和内容，恢复时可生成 ToolMessage |
| 工具分派开始或异常终止 | 9.3 的 `tool_start` / `tool_end` | 补足请求到结果之间的生命周期，正常结果仍只存一次 |
| turn 结束 | 沿用 9.1 的 `type: "turn_end"` | 评价整次提问的结果；生命周期与异常字段见 9.3 |

本轮建议不另建重复的 `tool_call` 记录；完整调用已在 `assistant.toolCalls` 中。同一结果只写一条 `tool_result`，不再写一条 `type: "message"` / `role: "tool"` 复制内容，避免恢复时出现双份工具结果。

现有校验只保证**同一 assistant 响应批次内**调用 ID 唯一。不同响应可能重复使用同一 ID，因此建议在工具结果 payload 增加存储层字段 `callMessageSeq`，指向提出调用的 assistant 记录的 `seq`。结果的本地配对键为 `(sessionId, turnId, callMessageSeq, toolCallId)`，不能只用全会话的 `toolCallId → result` 字典。

`callMessageSeq` 不属于现有 ToolResult 或模型请求格式。它在创建持久化记录时补入，恢复为 ToolMessage 时省略；同一批多个结果共享 callMessageSeq，各自使用不同的 toolCallId。

#### 一次完整工具往返的 JSONL 候选示例

以下是完整文件示例。时间只演示记录字段，不代表已经决定 append/fsync 的具体时机。

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"总结 README.md"}}
{"seq":2,"type":"message","timestamp":"2026-10-26T02:00:02.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"我先读取文件。","toolCalls":[{"id":"call-1","name":"read_file","argumentsJson":"{\"path\":\"README.md\"}"}]}}
{"seq":3,"type":"tool_start","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-1","name":"read_file"}}
{"seq":4,"type":"tool_result","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-1","name":"read_file","ok":true,"content":"# yucli\n一个终端 Agent 项目。\n"}}
{"seq":5,"type":"message","timestamp":"2026-10-26T02:00:05.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"README 介绍了一个终端 Agent 项目。"}}
{"seq":6,"type":"turn_end","timestamp":"2026-10-26T02:00:06.000Z","turnId":"turn-1","payload":{"outcome":"success"}}
```

这里 `seq: 2` 保存模型的调用，`seq: 3` 是 9.3 提议的分派开始标记，`seq: 4` 保存本地执行结果；`callMessageSeq: 2` 和 `toolCallId: "call-1"` 把结果定位到该 assistant 消息中的具体调用。`seq: 5` 是最终回答，`seq: 6` 才表示整个 turn 成功结束。

`argumentsJson` 在磁盘上看起来包含转义引号，是因为外层 JSON 保存了一个 JSON 字符串。读取 JSONL 后，该字段仍是 `{"path":"README.md"}` 的字符串。恢复器可解析它进行结构校验，再保留原字符串重建 assistant 调用；这一步不触发工具执行，也不把字符串直接当对象访问。

如果文件不存在，只需将上述文件中 `seq: 4` 和 `seq: 5` 的事件替换为：

```jsonl
{"seq":4,"type":"tool_result","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-1","name":"read_file","ok":false,"content":"[file_not_found] 文件不存在。"}}
{"seq":5,"type":"message","timestamp":"2026-10-26T02:00:05.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"README.md 不存在，暂时无法根据文件内容总结。"}}
```

这是同一示例文件的两行替换片段，header 和其他事件不变。工具结果是 `ok: false`，而模型随后正常解释了原因，因此这个示例仍以 `turn_end` / `outcome: "success"` 结束。整次 turn 执行失败时的记录见 9.3。

#### 如何恢复为现有 ToolMessage

对于具备恢复资格的消息组，结果记录到模型消息的转换可表示为：

```ts
// 讨论用映射示意。外部 JSON 必须先完成结构和引用校验。
const result = record.payload;

const message: ToolMessage = {
  role: "tool",
  toolCallId: result.toolCallId,
  name: result.name,
  content: result.content,
};
```

恢复器另行保留 `ok` 和 `callMessageSeq` 用于本地结果展示、诊断和配对。随后当前 HTTP adapter 再转换为 `{role:"tool", tool_call_id, content}`；不把 ok 或 callMessageSeq 加进模型请求，也不因恢复工具消息自动再次执行工具。

一个完整工具往返的结构检查应能确认：引用的是同一 turn 中更早的 assistant 记录；其中存在匹配的 ToolCall.id；工具名一致；每项调用有且仅有一个对应结果；结果按消息和工具执行顺序出现。缺失、重复或中断时的事件字段、合法组合和恢复处置见 9.3。

#### 当前代码能提供哪些保存输入

`runTurnStream` 完整成功后同时返回 `appendedMessages` 和 `toolResults`。前者给出 user/assistant/tool 的消息顺序，后者保留含 ok 的执行结果；只保存前者会丢失 ok，只保存后者又缺少用户消息和 assistant 调用。

最小接入路径可以顺序遍历 appendedMessages，遇到 tool 消息时消费下一项 toolResults，检查 ID、工具名和 content 一致，再生成一条 tool_result 并补入对应 assistant 记录的 seq。按批次和顺序配对，不依赖调用 ID 在整个 turn 中唯一。这说明现有成功返回值具备保存所需的数据，不表示阶段 04 必须继续依靠两份数组配对；是否重构交付方式见下文。持久化 schema 仍应有独立运行时校验和 formatVersion；代码类型后续变化不能静默改变已写文件的解释。

当前异常出口不交付部分 `StreamTurnResult`，`executeToolBatch` 也不返回半批结果，因此现有实现不能承诺保存崩溃前的每个工具动作。9.3 拟将中间事实保存纳入阶段 04，需要调整 core 的事件交付与保存边界。本次仅修改调研记录，不改变现有类型或代码行为。

#### 既有代码调整评估

以下是基于当前 9.2 候选需求的评估，区分推荐重构与新增需求触发的必要改动。两份结果视图本身不构成运行错误；如果只保存完整成功的 turn，现有返回值加存储转换即可实现本节示例。

| 位置 | 现状与问题 | 候选调整及必要性 |
| --- | --- | --- |
| `ToolCall`、`ToolResult`、`ToolMessage` | 完整调用和结果字段已具备，模型消息不含 ok | 目前可保留其职责划分；保存 ToolResult.ok，生成模型消息时省略，无需为持久化给 ToolMessage 增加 ok |
| `core/agentLoop.ts`、`core/runTurnStream.ts` 中的结果转消息逻辑 | 两处分别把 ToolResult 转成 ToolMessage，恢复逻辑也需要同一映射 | 推荐提取 core 的纯转换函数，供运行与恢复共用，集中保持 ID、名称和 content；属于可维护性重构，不改变对外行为 |
| `StreamTurnResult` 与 `runTurnStream` 的交付方式 | appendedMessages 和 toolResults 是两份视图，保存时需重新关联；只消费消息视图会丢 ok | 推荐评估用有序的完整业务事实作为明确来源，再派生消息历史和诊断结果，减少存储层重新配对；现有数组也可作为派生视图保留。不是让 9.2 成立的硬性前提，具体接口待设计 |
| `executeToolBatch`、`runTurnStream` 的中途交付 | 批次和 turn 失败时不交付已有结果，外层无法保存已完成的中间工具事实 | 按 9.3 在阶段 04 保存中断前的调用/结果，需要调整交付逻辑，例如提供结构化业务事件；保留整批预检、顺序执行和取消检查，不能为记录结果而执行原本不应执行的工具 |
| `callMessageSeq` 与调用身份 | 现有工具 ID 只保证批次内唯一，文件引用属于新的存储数据 | 当前候选方案可由持久化记录创建方补入引用，无需改写模型给出的 ID；如果后续设计引入稳定的内部调用身份，允许替换本候选字段并同步示例与恢复校验 |

若引入结构化业务事件，事件应携带完整 ToolResult 等业务事实，由外层协调保存；core 不直接读取或写入 JSONL，也不依赖文件行号或具体存储实现。事件等待与保存失败传播见 9.4、9.7，取消顺序见 9.3–9.4；不能只增加一个回调就宣称可靠落盘。

模型上下文的提交与执行事实的保存应分别定义：即使记录了某项中间工具结果，仍可以保持失败 turn 不提交半截模型历史的行为。交付接口是推荐评估的重构方案，具体恢复投影的候选规则见 9.3。

对应验证应覆盖：原有 ok:true/false、空文件和未知工具结果的转换保持一致；文件恢复生成的 ToolMessage 不包含 ok 或存储引用；多批次复用调用 ID 时配对正确。落实 9.3 的中途事实交付时，还需验证“第一项工具完成、第二项取消”和“工具完成、后续模型失败”的事实交付与历史提交边界。形成阶段规格后再把确认的重构与这些验证要求纳入任务。

源码依据：[消息类型](../../src/contracts/message.ts)、[工具类型](../../src/contracts/tool.ts)、[结果生成与异常](../../src/core/toolRegistry.ts)、[流式 turn 的两份结果视图](../../src/core/runTurnStream.ts)、[HTTP 消息映射](../../src/adapters/opencode-go/OpenCodeGoClient.ts)。

### 9.3 数据结构讨论（三）：turn 与工具的生命周期和状态记录

讨论日期：2026-10-26（Asia/Shanghai）。状态：**阶段 04 的候选设计，待逐项评审**。

本轮讨论将恢复必需的 turn 和工具状态记录纳入阶段 04：既保存完整成功的问答，也保存中断前已经交付的完整业务事实。自动重跑、复杂重试、并发工具和逐 token 持久化留到后续需求出现时设计。以下事件和错误字段为拟议的持久化格式，不表示现有源码已经具备这些能力。

#### turn 状态与保存状态分别表达

一个 turn 从用户输入被接受开始，到成功、失败、取消或超时结束。同一进程内正在运行的 turn 与恢复时发现的旧 turn 必须区分；恢复不继续旧网络请求或工具执行。

| turn 状态 | 依据 | 是否新增专门记录 |
| --- | --- | --- |
| 已接受 / 运行中 | user 消息已被接受，当前进程持有该 turn，尚未产生结束事件 | user 的 `message` 同时表达 turn 起点，本候选方案不重复写 turn_start；运行中是内存状态 |
| `success` | 获得非空白的完整最终 assistant 回答，调用与结果结构完整，正常结束 | 写 `turn_end`，payload.outcome 为 success |
| `failed` | 模型请求、协议、额度或不可恢复内部错误导致停止 | 写 `turn_end(failed)` 及结构化 error |
| `cancelled` | 当前进程观察到调用方取消并停止继续执行 | 写 `turn_end(cancelled)` 及取消原因 |
| `timeout` | 已定义的执行期限首先到达 | 写 `turn_end(timeout)` 及超时来源；当前可直接映射的期限是既有模型请求超时 |
| `interrupted` | 恢复时发现有 user，但没有可确认的 turn_end | 只在内存推导，不在恢复时自动追加 turn_end(interrupted) |

会话保存本身另有 `pending / saved / failed` 状态，保存在当前进程的存储协调状态中。模型生成了回答并不代表保存成功；`saved` 只能在约定的持久化确认点完成后报告。不能靠再写一个“已保存”事件来证明该事件本身一定保存成功。具体 append、flush、fsync 和崩溃保证见 9.4。

这里的最终回答要求 assistant 没有非空 toolCalls，且 content 是字符串并满足 `content.trim().length > 0`；trim 仅用于检查，保存时保留原文。空字符串、纯空白或缺失 content 均不能成为成功的最终回答；有合法 toolCalls 时可以没有文本，成功工具结果的 content 也可以为空，例如空文件。

这项限制**当前已经存在**：`StreamAssembler.finish()` 经 `runTurnStream` 调用时会拒绝无工具的空白响应，非流式循环也有对应检查。阶段 04 需要保持原行为，把异常映射为 `turn_end(failed)` 的 `model/invalid_response`，并让恢复校验执行同一规则；不新增 `empty_response` 分类，也不把无效最终响应保存成合法 assistant 消息。来源：[流式响应校验](../../src/core/streamAssembler.ts)、[既有空白响应测试](../../tests/stream.test.ts)、[非流式循环](../../src/core/agentLoop.ts)。

#### 工具状态如何由事件得到

工具调用沿用 9.2 的 `(sessionId, turnId, callMessageSeq, toolCallId)` 关联，调用本身保存在 assistant.toolCalls 中。

| 工具状态 | 证据 | 含义 |
| --- | --- | --- |
| 已请求 | assistant 消息中有完整、经结构校验的 ToolCall | 模型提出调用，尚不能说明工具已经执行 |
| 分派开始 / 进行中 | 当前进程正在处理该调用，对应 `tool_start`，尚无终止结果 | 交给注册表分派的开始；包含名称查找，不保证匹配成功，也不保证实际 execute 已发生 |
| 已成功 | 对应 `tool_result` 且 ok:true | 已取得完整成功结果，保存实际返回内容 |
| 可恢复工具错误 | 对应 `tool_result` 且 ok:false | 正常返回了文件不存在等错误，模型仍可据此回答 |
| 分派前取消 | tool_start 后有 tool_end(cancelled)，error.code=cancelled_before_dispatch | core 明确未调用注册表，并已交付该事实；恢复可确认取消，不能误标 unknown，也不归为无 start 的 not_started |
| 分派失败、取消或超时 | 对应 `tool_end`，outcome 为 failed/cancelled/timeout；其他取消保留实际原因 | 调用异常停止，没有可交付的正常 ToolResult；进入注册表后通常不能凭此断言外部操作没有发生 |
| `not_started`（未开始） | 存在有效 turn_end，调用没有 tool_start，且顺序执行与保存确认规则能证明未分派 | 可出现在 failed/cancelled/timeout turn 的剩余调用中；success 要求全部有结果，因此不允许此状态 |
| `unknown`（结果未知） | 恢复时没有工具终止记录，且满足“缺少 turn_end”或“已有 tool_start”任一条件 | 缺少 turn_end 时，只有请求也保守归为 unknown；有 start 但没有终止记录时，即使 turn 已失败、取消或超时也仍为 unknown |

`tool_start` 表达的是开始分派的意图和阶段边界。即使先保存它再执行，也存在“保存后、调用前”崩溃窗口；工具完成后也可能在结果保存前崩溃。因此，已见 start 不证明工具执行过，没有 result 也不证明工具没有完成。只读 read_file 也不通过重新读取来冒充原执行结果。

本轮采用方案 A：先确认保存 tool_start，再进入注册表查找名称和分派。未知名称的合法序列是 `assistant.toolCalls → tool_start → tool_result(ok:false)`，与当前 RegisteredTools 返回 `[unknown_tool]` 结果的行为一致；名称与原 ToolCall 匹配即可，不要求名称存在于当前注册表。拒绝“先查名称，未知工具只有 result 没有 start”的例外路径。

tool_start 确认后、调用注册表前若观察到取消，core 明确不调用注册表，交付 `tool_end(outcome:cancelled)`，error 使用 `category:cancellation`、`code:cancelled_before_dispatch`，协调方再以同一取消原因关闭 turn。这是已知的“分派前取消”，不引入新 outcome。若已经进入注册表，即使尚未调用具体 execute，也不推断该代码；按实际观察到的取消原因记录。恢复仅剩 start、没有合法终止记录时仍为 unknown；tool_end 保存失败走存储故障，不伪装成已保存的取消。

状态推导先看已保存的 tool_result/tool_end，再判断尚未终止的调用；整个 turn 为 interrupted，不会把其中已知成功或已知异常的工具重新标为 unknown。`not_started` 的判断依赖有效终止记录及 9.4 的执行前保存确认；语义损坏的文件直接拒绝恢复，不能先跳过坏记录再声称调用未开始。

例如一批有 A、B、C，A 已返回结果，B 开始后被取消并记录 tool_end，随后 turn_end(cancelled)：A 保留真实结果，B 为 cancelled，C 为 not_started。若缺少 turn_end，则 A、B 的已知终止状态保留，C 保守归为 unknown；若 B 连 tool_end 也没有，则 B 同样为 unknown。

当前模型请求有超时；工具 timeout 只有在另行定义工具执行期限后才能产生，不因复用枚举值就宣称 Node 文件调用可被抢占取消。

#### 事件划分与新增字段

| type | payload 的候选结构 | 是否成为模型消息 |
| --- | --- | --- |
| `message` / user | payload 沿用 `{role:"user",content}`；记录外层另存 runtimeProfile，来自 user TurnFact 外层 | 仅 payload 按 turn 恢复资格成为模型消息，runtimeProfile 不进入 Message |
| `message` / assistant | 沿用完整文字和 toolCalls；不保存未校验的流式调用片段 | 按 turn 的恢复资格决定 |
| `tool_start` | `{callMessageSeq,toolCallId,name}` | 否，仅用于恢复和诊断 |
| `tool_result` | 沿用 `{callMessageSeq,toolCallId,name,ok,content}` | 由此派生 ToolMessage，省略 ok 和存储引用 |
| `tool_end` | `{callMessageSeq,toolCallId,name,outcome,error}`，outcome 为 failed/cancelled/timeout | 否，不伪造普通工具结果 |
| `turn_end` | `{outcome,error?}`，outcome 为 success/failed/cancelled/timeout | 否，决定整组历史是否可提交 |

一次正常分派以 `tool_result` 或异常 `tool_end` 收尾，二者互斥；同一 turn 最多写一条 turn_end，且之后不再追加属于该 turn 的记录。取消与超时竞态由协调层串行确定并保留首先确认的终止原因，不能分别再写两个终止事件。只有在尚无已交付正常结果时，才写 tool_end；若已取得并交付 ToolResult 后发生取消，保留真实 tool_result，并由 turn_end 表达整次 turn 的取消。

新增 error 是持久化用的安全诊断对象，不直接 JSON.stringify 原始 Error：

| error 字段 | 候选含义 |
| --- | --- |
| `category` | model、tool、protocol、limit、cancellation、timeout 或 internal |
| `code` | 稳定机器码，如 network、http、invalid_response、protocol_error、loop_limit、user_interrupt、cancelled_before_dispatch、request_timeout、tool_execution_failed |
| `message` | 经过整理和脱敏的用户可读摘要，不包含堆栈或原始异常 |
| `httpStatus?` | 已知模型 HTTP 状态时可保存整数状态码，不保存认证头或完整响应体 |

success 的 turn_end 不带 error；failed/cancelled/timeout 的 turn_end 与异常 tool_end 带对应 error。工具的可恢复错误继续使用 ToolResult.ok:false 和安全 content，不从 content 前缀反推结构化错误码。若以后需要文件错误的细分类，应让工具结果显式交付，不能把自然语言当作错误协议。

映射现有错误时，RequestError 的 network/http 归 model，timeout 归 timeout；ResponseError 归 model/invalid_response；额度耗尽归 limit，调用参数或批次结构非法归 protocol，用户取消归 cancellation。当前 RegisteredTools 把不可恢复工具异常包装成 protocol_error，会丢失“工具内部执行失败”的分类；阶段 04 应调整此处的错误类型或显式来源，使它可归 tool/tool_execution_failed。启动阶段的配置或参数错误发生在接受 turn 之前，仍直接报告，不凭空创建用户 turn。

#### 交付顺序与旧代码需要的调整

本节推荐的顺序为：

1. 外层协调方接受输入，创建 turnId，交付并保存唯一 user 消息；core 返回值中的 user 不再重复写入。
2. 模型响应完整收尾，通过响应结构校验和整批参数预检后，交付 assistant 消息；即使其中有文字，也以 toolCalls 判断是否需要工具。不把未通过结构校验的调用伪装成合法 ToolCall 记录，预检失败时不开始任何分派。
3. 保持每批 4 项与每 turn 8 次模型上限。最后一次模型机会仍请求工具时，可以保留已校验的完整请求事实，再按额度规则终止，不能执行工具。
4. 每项实际分派前检查取消与额度，交付 tool_start；等待该前置事件达到 9.4 的保存确认点，再次检查取消，然后进入注册表进行名称查找和分派。未知名称也已经有 start，随后交付 ok:false 结果；若再次检查时已取消，则不调用注册表，先等待 tool_end(cancelled) 确认，error 使用 cancellation/cancelled_before_dispatch，再由协调方关闭该 turn。core 使用业务关联信息，JSONL 的 seq 与 callMessageSeq 由存储转换方生成。
5. 每取得一项完整 ToolResult，就交付含 ok 的结果事实，外层保存 tool_result；保持逐项顺序，不等整批或整个 turn 成功后才交付。普通可恢复错误也走这一条。新接口应将“取得完整结果”和“下一步取消检查”分开，避免结果已得到却因后续取消而丢掉已知事实；检查取消后不再开始下一项工具或模型请求。
6. 当前项没有正常结果而因取消、超时或异常停止时，交付对应 tool_end；再用 turn_end 关闭整次 turn。尚未分派的剩余调用由事件证据推导，不为它们生成假结果。
7. core 正常交付最终回答后返回临时成功结果，协调方固定 outcome 并唯一交付 turn_end。只有完整消息组、正常结果配对和 turn_end(success) 都达到保存确认点后，才向 REPL 提交这组模型历史，具体接口见 9.7。

这要求修改 `runTurnStream` 的成功返回值交付模式，并调整 `executeToolBatch` / RegisteredTools 的逐项交付与错误分类；只在外层 catch 中保存错误，或只遍历成功返回的两个数组，无法满足本节的中间事实保存目标。`ToolResult` 与 `ToolMessage` 的职责仍可保留，统一转换函数可供运行与恢复共用。

9.7 具体化 contracts 中的 CoreTurnFact/TurnFactSink：core 顺序交付 assistant、工具开始/结果/异常事实并等待确认；外层协调方唯一负责 user 和 turn_end。保存失败原样传播，不让 core import 文件 adapter，不将 JSONL 对象或文件 seq 塞进核心循环。

收到取消后仍需要尝试记录终止原因；保存收尾不能直接复用已经 aborted 的模型/工具 signal，否则可能永远写不出终止事件。收尾等待应有边界，具体关闭与存储超时策略留到落盘可靠性设计。工具和服务端操作是否真正停止仍受各自能力限制。

#### 完整示例：第一项工具完成，第二项被取消

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"读取 a.md 和 b.md 并总结"}}
{"seq":2,"type":"message","timestamp":"2026-10-26T02:00:02.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"我会依次读取两个文件。","toolCalls":[{"id":"call-a","name":"read_file","argumentsJson":"{\"path\":\"a.md\"}"},{"id":"call-b","name":"read_file","argumentsJson":"{\"path\":\"b.md\"}"}]}}
{"seq":3,"type":"tool_start","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file"}}
{"seq":4,"type":"tool_result","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file","ok":true,"content":"文件 A 的内容。"}}
{"seq":5,"type":"tool_start","timestamp":"2026-10-26T02:00:05.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-b","name":"read_file"}}
{"seq":6,"type":"tool_end","timestamp":"2026-10-26T02:00:06.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-b","name":"read_file","outcome":"cancelled","error":{"category":"cancellation","code":"user_interrupt","message":"用户取消了本次执行。"}}}
{"seq":7,"type":"turn_end","timestamp":"2026-10-26T02:00:07.000Z","turnId":"turn-1","payload":{"outcome":"cancelled","error":{"category":"cancellation","code":"user_interrupt","message":"用户取消了本次执行。"}}}
```

这里 call-a 的成功结果仍然保存；call-b 的分派被取消，没有把取消包装成 ok:false。没有最终 assistant 回答，整个 turn 为 cancelled，以上记录供恢复展示与诊断，整组不进入后续模型上下文。

如果同一进程在写完第二项的 tool_start 后崩溃，文件可能仅剩以下有效前缀：

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"读取 a.md 和 b.md 并总结"}}
{"seq":2,"type":"message","timestamp":"2026-10-26T02:00:02.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"我会依次读取两个文件。","toolCalls":[{"id":"call-a","name":"read_file","argumentsJson":"{\"path\":\"a.md\"}"},{"id":"call-b","name":"read_file","argumentsJson":"{\"path\":\"b.md\"}"}]}}
{"seq":3,"type":"tool_start","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file"}}
{"seq":4,"type":"tool_result","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-a","name":"read_file","ok":true,"content":"文件 A 的内容。"}}
{"seq":5,"type":"tool_start","timestamp":"2026-10-26T02:00:05.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-b","name":"read_file"}}
```

恢复时能确认 call-a 有正常结果，call-b 的结果未知，整个 turn 在内存标为 interrupted。不追加修复性 turn_end，不合成 tool message 填补未知结果，不自动重跑任一工具；需要重试时由用户重新提交输入并创建新的 turnId。

#### 完整示例：模型 HTTP 失败

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"你好"}}
{"seq":2,"type":"turn_end","timestamp":"2026-10-26T02:00:02.000Z","turnId":"turn-1","payload":{"outcome":"failed","error":{"category":"model","code":"http","message":"模型请求失败。","httpStatus":503}}}
```

模型请求已失败，因此没有伪造 assistant 或工具结果。若模型请求超时，turn_end 使用 timeout，error.category 使用 timeout，code 使用 request_timeout；取消则使用 cancelled 与 cancellation/user_interrupt。

#### 保存失败和恢复边界

保存失败时，当前进程报告明确的存储错误，将会话标为未保存，停止开始新的模型/工具操作，并触发当前 turn 的取消与可取消资源清理；不承诺把故障本身再写进同一个故障文件，也不保证已开始的外部操作可被撤回。已写入的前缀、正在完成的文件操作和已显示的文本分别处理，不把内存中的完成状态当作可靠落盘证据。9.4 给出保存确认、故障后停止追加和禁止盲目重试规则；独占打开与退出分类见 9.5，坏尾行的字节边界和修复见 9.6。

恢复建议继续采用完整 turn 提交边界：只有具有有效 turn_end(success)、完整最终回答以及全部调用/结果配对的 turn 才进入下一次模型上下文。可恢复工具错误的 ok:false 是正常结果，仍可属于成功 turn；异常 tool_end 则没有正常结果，不能靠合成消息把该 turn 变成 success。

failed/cancelled/timeout/interrupted turn 的 user、已完成的中间 assistant/tool 事实和异常记录保留作日志与可展示历史，整组排除出模型上下文。已有明确失败或取消原因时保留原分类，不统统改成 interrupted。重复恢复同一有效前缀得到同一状态；恢复本身不修改文件。新输入开始新的 turn，不继续旧的未完成执行。

#### 合法组合与恢复校验表

以下是 v1 候选格式的约束，写入前与恢复时都需要校验。表中的“拒绝”统一指**拒绝将整个会话文件恢复为可继续执行的会话**；不能丢弃损坏 turn 后继续投影其他 turn。诊断工具仍可只读展示出错位置，但不得把不完整解释当作健康历史提交模型。

| 规则 | 违反时 |
| --- | --- |
| header 必须是第一个物理行，且整个文件只出现一次；formatVersion 必须受支持 | 拒绝；后续 session_meta 不能充当新文件的起点 |
| 每行是符合对应 schema 的对象；必填字段、消息/调用/错误字段类型合法，type 为已知类型 | 拒绝；v1 未定义可忽略事件，不能静默跳过未知 type |
| user 记录上存在 runtimeProfile 时，必须符合 9.5 的 v1 provider/model 结构；缺失仅表示历史提供方/模型未知 | 字段缺失、空白或类型非法拒绝；不能忽略损坏摘要后声称提供方/模型一致 |
| seq 是从 1 开始的连续正安全整数；timestamp 仅作时间信息，不参与排序 | 重复、缺口、倒退或类型错误拒绝；不通过重排或重编号修复 |
| 每个 turn 恰有一个 user 起点，且是该 turn 第一条记录；turnId 的记录连续，开始新 turn 后不能返回旧 turn | 多余 user、无 user 的事件或跨 turn 交错拒绝；v1 不支持 steering 或并发 turn |
| 一个 turn 最多一个 turn_end，且是**属于该 turn**的最后一条记录 | 重复结束或后续任意同 turn 记录拒绝；后续新 turn 合法 |
| assistant.toolCalls 沿用完整批次结构校验，同批 ID 唯一，保持数组顺序 | 拒绝；非法调用不因尚未执行就变成合法记录 |
| tool_start/tool_result/tool_end 的 callMessageSeq 是更早的正安全整数，指向同 turn 的 assistant，且其中存在 toolCallId 与 name 同时匹配的调用 | 引用缺失、指向其他角色/turn/未来记录或名称不一致均拒绝 |
| 在同一文件及 turn 中，工具配对键严格为 `(callMessageSeq, toolCallId)` | 跨批次允许复用 ID；实现只按全局 toolCallId 配对不符合契约 |
| 每个调用最多一个 tool_start；tool_result/tool_end 必须有前置 tool_start | 重复 start 或无 start 的终止记录拒绝，未知名称也无例外 |
| 每个调用最多一个终止记录，tool_result 与 tool_end 互斥 | 同时出现或任一重复均拒绝；不以最后一条覆盖前一条 |
| tool_result.ok 必须是布尔值，content 必须是字符串；tool_end.outcome 只能是 failed/cancelled/timeout | 类型或枚举错误拒绝；空字符串工具结果合法 |
| 工具按原批次顺序分派，前项 tool_result 后才可开始后项；一旦出现 tool_end 或悬空 start，不再分派后项 | 越序、重叠分派或异常后继续调用拒绝；与 v1 顺序执行及遇异常停止的行为一致 |
| 下一条 assistant 只在上一批所有调用均有 tool_result 后出现；无调用的最终 assistant 后不再追加本 turn 的业务消息 | 拒绝；失败时可以没有最终 assistant，但不能绕过未完成批次继续模型往返 |
| turn_end.outcome 只能是 success/failed/cancelled/timeout；success 不带 error，其余必须带有效 error | 拒绝；cancelled 对应 cancellation，timeout 对应 timeout，failed 使用失败来源分类 |
| 每条 tool_end 必须带与其 outcome 对应的有效 error | 缺失、类型或分类不匹配拒绝；可恢复工具错误仍用 tool_result(ok:false) |
| turn_end(success) 要求全部 call 都有 tool_start 与 tool_result，无 tool_end，最后一条业务消息是非空白且无调用的最终 assistant | 缺结果、悬空 start、只有调用没有最终回答、空白最终回答等均拒绝 |
| failed/cancelled/timeout 中，允许剩余调用没有 start，也允许已有 start 没有终止记录 | 前者依据顺序证据为 not_started，后者为 unknown；不因此把 turn 改成 success |
| 没有 turn_end 的有效执行前缀可以保留；开始新的 user turn 后不再补写旧 turn | 原 turn 推导为 interrupted；已知工具终止状态保留，尚未终止的调用为 unknown；不追加修复性 turn_end |

“没有结束事件”与“已经结束但不符合其 outcome 条件”不同。前者可以是正常写入顺序留下的崩溃前缀；后者属于语义损坏。例如 success 缺 result，即使刚好出现在文件末尾，也必须拒绝，不能改成 interrupted 来规避校验。只有 header、尚无 turn 的文件可表示空会话；header 缺失或不完整不能恢复。

尾部坏行的例外建议限定为：前缀全部有效，最后一个**未以换行结束**的物理行能判定为 JSON 值或 UTF-8 字节序列尚未写完时，只读取此前完整前缀并报告尾部字节位置。明确非法的语法/字节、中间坏行、以换行结束的坏行、空白记录，以及能够解析为 JSON 但 schema/语义非法的尾行均拒绝；不跳过后面的记录来拼接历史。完整 JSON 即使缺少末尾换行，也先执行全部校验，不能用“未换行”掩盖语义损坏。恢复读取不改原文件；继续追加前必须由写入端在独占条件下处理尾部，不能直接把新 JSON 接在残片后面。

拒绝时至少报告文件路径、物理行号/字节位置、可解析的 seq、turnId、调用引用和具体原因，例如“第 7 行 seq=6：tool_result 缺少前置 tool_start”。不静默跳过，不为报错输出完整用户文本、工具参数或文件内容。

#### 阶段 04 的实现范围与验收要求

- 交付并保存基本生命周期事件，保留已完成的中间工具结果；不等待整个 turn 成功后才保存所有工具事实。
- 保持整批预检、顺序执行、取消边界和调用额度；不增加自动重跑或并发执行。
- 取消或超时发生在工具之间时，保留前项真实结果、停止后项；发生在进行中的工具时，记录已知终止原因并保留结果未知的语义。
- 验证进程崩溃留下 user-only、tool_start-only 和“一个结果完整、后一项未完成”的前缀，恢复不重复执行，不把半截历史提交模型。
- 验证工具 ok:false 后模型正常解释仍可成功，以及工具完成后模型失败仍保留工具事实。
- 按校验表验证同批多个调用、跨批复用 ID、重复终止事件、缺失引用、越序分派和 success 却缺工具结果等边界；语义损坏拒绝整个文件，末尾未完成写入单独处理。
- 保持既有空白最终回答拒绝行为，增加错误落盘映射与恢复侧空白最终回答校验；空工具结果仍然合法。验证 not_started/unknown 的证据区别及 interrupted turn 内已完成结果不被覆盖。
- 注入 append/保存确认失败，验证不开始后续外部操作，不误报保存成功；新行为和错误分类需同步 contracts、core、bootstrap、文档与相应测试。

### 9.4 保存确认点与写入顺序

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选策略，待评审；尚未实现**。

本节补充 9.3 状态判断所依赖的写入保证。如果只规定有哪些事件，却不规定何时等保存完成，就可能在工具已经执行后丢失调用请求，也可能在日志未保存时向用户报告成功。

#### “确认保存”具体确认什么

三个层次需要区分：

| 完成层次 | 能确认的事实 | 是否作为本候选策略的保存确认点 |
| --- | --- | --- |
| 已接受进内存队列 | 当前进程记住了要写什么 | 否，进程退出可能全部丢失 |
| 完整写入，且应用缓冲已 flush | JSON 和末尾换行已交给操作系统；短写已处理 | 否，不能据此宣称已经完成文件同步 |
| 完整写入、排空应用缓冲，再完成文件同步 | 对截至该 seq 的全部已写前缀执行 fsync，例如 Node FileHandle.sync()，并成功返回 | 是，作为 v1 的默认推荐 |

建议先使用简单的串行写入器：一次写完整 UTF-8 JSON 加换行，处理短写，必要时排空应用缓冲，执行文件同步，再向调用方确认截至哪个 seq 保存成功。直接使用 FileHandle 时不虚构独立的 flush API。后续事件不能越过未确认事件；无需为了队列、后台线程或批量优化引入额外框架。工具/模型操作本来按顺序执行，先用每个业务屏障一次同步换取清晰语义；若测出同步成本明显，再讨论合并，但不能把后续有副作用的步骤提前到屏障之前。

本策略以同一文件同一时刻只有一个写者为前提。进程内串行写入不等于跨进程排他；独占打开、冲突处理及锁候选验证见 9.5，不能仅靠 append 模式保证这些因果约束。

新文件必须先保存并同步 header，再接受 user；文件首次创建还需要在支持的平台同步父目录，保证目录项的持久化。新建多级目录时同样需要考虑各级目录项；目录、权限和已验证平台范围见 9.5。文件 fsync 不等于新路径一定可在断电后找回，也不承诺所有硬件/文件系统上的绝对不丢失；不能把不支持的同步悄悄当作成功。这里选择的保证强于“进程收到 write 回调”，不把已接受队列或普通 flush 称为耐久保存。

#### 哪些步骤必须等待确认

| 当前事实 | 确认保存后才允许的下一步 |
| --- | --- |
| 新文件的 header 与必要的目录创建 | 接受该会话的 user 输入 |
| user 消息 | 发起本 turn 第一次模型请求 |
| 含 toolCalls 的完整 assistant 消息 | 写本批第一项 tool_start；不能先分派工具再补调用记录 |
| 当前项 tool_start | 再检查取消/额度，通过后才进入注册表名称查找与分派 |
| 当前项 tool_result | 开始下一项工具；整批结果齐全后才可发起下一次模型请求 |
| 当前项 tool_end | 写本 turn 的非成功 turn_end；不再开始下一项工具或模型请求 |
| 无调用、非空白的完整最终 assistant | 写 turn_end(success)；若此时已观察到取消，则按协调层确定的终止原因收尾 |
| turn_end(success) | 向 REPL 报告本 turn 成功且已保存，并提交完整模型历史 |
| turn_end(failed/cancelled/timeout) | 报告本 turn 已按对应原因结束且日志已保存，允许接受下一次输入 |

表中“保存”都使用上一表的确认点。tool_end 之后的下一步只有非成功 turn_end，不能把“结果/终止记录确认后才进入下一步”理解为异常后也能继续执行。模型 HTTP 失败等没有工具终止事件的路径，也必须等待对应 turn_end 确认后才允许下一次输入。

流式文字可以在完整 assistant 与 turn_end 保存之前已经显示；屏幕有文字不代表 turn 成功或历史已提交。若最终保存失败，REPL 应明确报告未保存，不能仅凭文本生成结束就显示成功；本候选方案不要求把已经输出的文字撤回。

取消可能发生在任意等待点。准备继续执行时，确认返回后仍应检查取消，防止保存等待期间收到的取消被忽略；已经取得的完整结果先交付并保存，再检查是否继续，避免把已知结果丢掉。协调层在交付 turn_end 前检查并固定唯一 outcome；交付后、保存确认期间新到的取消不能改写它或追加第二个 turn_end，保存成功后按已固定的结果报告。终止事件的保存使用独立且有界的收尾机制，不沿用已 aborted 的模型/工具 signal；若收尾也失败，按存储失败报告，不能假装取消日志已保存。具体存储等待上限与退出处理在后续规格中确定。

#### 保存失败与不确定窗口

写入、flush 或 sync 失败时，调用方只知道“没有收到成功确认”，不能断言该记录一定未写入。写入器进入故障状态，拒绝后续追加；协调层停止新的模型/工具操作、尝试清理当前资源，并报告最后已确认 seq 和失败位置。不能用同一 seq 盲目追加重试，也不能在残缺尾行后继续写；当前格式没有定义 eventId 去重或 exactly-once 语义。

以后重新打开文件时，按 9.3 校验实际有效前缀。完整合法但当时未获确认的记录可以存在于文件中；有合法 turn_end 时按文件证据恢复，没有时推导 interrupted，不能凭上次内存里“应该成功了”补写结果。普通恢复读取保持只读；继续写入所需的独占、尾部处理和同步必须在开启新执行前完成。

工具执行与文件同步无法组成一个原子事务：tool_start 确认后、分派前可以崩溃，工具完成后、tool_result 确认前也可以崩溃。因此这套顺序用于限制不确定窗口、保存可验证的因果关系，不提供工具恰好执行一次的保证，也不改变 unknown 调用禁止自动重跑的规则。

#### 参考实现带来的取舍与阶段影响

- DSH 的 storage-contract 校验存储事件并拒绝未知的必需事件，assertContiguous 校验追加批次连续性。借鉴其显式契约与错误诊断；本报告的 turn/tool 组合表仍是 yucli 自己的候选规则。
- Codex RolloutRecorder.flush() 通过写入队列发送屏障并等待确认，适合参考“排队不等于保存完成”的接口语义；当前快照 recorder 的 write_pending_once/write_line 调用的是文件 flush，未见 sync_all/sync_data，不能据此声称其确认等同 fsync。其读取器会计数并跳过解析错误，yucli 不直接采用这一宽容策略。
- Pi 使用同步 writeFileSync/appendFileSync；同步调用返回不等于显式 fsync。其读取器也会跳过坏行，不能作为本候选严格恢复策略的依据。
- ZCode hydrator 区分 completed/error 与未完成工具，但会为未完成项合成中断结果；yucli 延续 9.3 的选择，保存已知事实，未成功 turn 整组不进模型，不靠合成结果补齐成功历史。

源码依据：[DSH 存储契约](../../../references/dsh/packages/session/session-persistence/src/storage-contract.ts)、[Codex 写入确认与读取](../../../references/codex/codex-rs/rollout/src/recorder.rs)、[Pi 会话读写](../../../references/pi/packages/coding-agent/src/core/session-manager.ts)、[ZCode 历史恢复](../../../references/zcode/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts)。

阶段 04 若采用本策略，需在 contracts 定义可等待的业务事实交付及保存失败传播，在 core 的模型/工具边界等待它，在存储 adapter 实现有序完整写入与确认，在 bootstrap/REPL 区分执行结果、保存结果和历史提交。JSONL seq、文件句柄与同步细节仍由存储层负责；既有文件尚不存在，无历史数据迁移，既有消息和正常工具结果语义保持不变。

验收应注入延迟和失败，验证 user、assistant、start、result/end、turn_end 的确认屏障均不能被下一步越过；特别检查 tool_start 确认前 execute 不发生，turn_end 确认前 REPL 不提交成功历史，确认丢失不盲目重试。再验证取消发生在等待中、结果返回后及终止保存中时，事实保留与停止边界一致。进程强制终止可以验证有效前缀恢复；它不能替代实际断电测试，也不能证明硬件级耐久性。

### 9.5 会话文件管理与生命周期

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选设计，供评审；未修改实现**。

本节围绕“在一个项目中开始对话，退出后选择同一会话继续”讨论文件、列表、运行配置和资源生命周期。消息投影规则已由 9.3 定义；9.6 给出扫描/尾部修复的具体流程，9.7 给出 core/storage 的交付接口，均在本报告中可连续阅读。

#### 当前项目的起点与参考取舍

当前 CLI 两种模式都调用 displayTurn/runTurnStream；REPL 自己保存最近 20 组成功消息，退出后消失。read_file 的根目录固定为启动 cwd，模型配置也在启动时加载一次。项目没有会话文件或跨进程写者管理；不能把这些候选能力写成已有实现。

| 参考实现 | 可借鉴的做法 | 对 yucli 的取舍 |
| --- | --- | --- |
| Pi SessionManager | 时间戳加会话 ID 命名，首次消息实体化，用独占创建避免覆盖 | 借鉴可读命名和延迟创建；不复制其按 cwd 编码建子目录、树分支及读取时修改尾部的全部行为 |
| DSH SessionHandle / JSONL lease | 区分 read/write 句柄，写者持有跨进程所有权；关闭后不能继续操作，内核锁随持有者退出释放 | 借鉴资源归属和稳定锁文件；不引入其插件容器、压缩、格式代际或整套原生系统包 |
| Codex WriterLockCoordinator | 活跃写者冲突立即失败，锁的生命周期覆盖后台文件工作 | 借鉴“文件操作真正结束前不能释放写入权”；不照搬其锁文件删除及全局协调锁，yucli 推荐保留稳定锁文件 |
| ZCode runtime / SessionStore | 首次 turn 创建会话，核心经 port 表达保存意图，工作目录来自 runtime 配置 | 借鉴惰性创建和依赖方向；当前规模仍使用 JSONL，不引入 SQLite message/part 表与后台标题生成 |

本次核对的 Pi session-manager 路径未见跨进程会话写锁；其其他模块使用 proper-lockfile 不能证明会话文件也有同样保护。DSH 的内核锁来自原生 addon，Codex 使用 Rust 文件锁；Node 24 的标准 fs 接口没有等价的跨平台 flock，不能只写一个进程内队列就声称已经复用其跨进程保证。

#### 默认布局、身份与权限

推荐将应用数据根放在 `os.homedir()` 下的 `.yucli/`，会话正文采用**扁平目录**。下图时间与 UUID 为示例，冒号和小数点替换为连字符：

```text
~/.yucli/
├── sessions/
│   └── 2026-10-26T02-00-00-000Z_9f7088b6-7ca6-4fd0-955a-68f05f9ca2ea.jsonl
├── locks/
│   └── 9f7088b6-7ca6-4fd0-955a-68f05f9ca2ea.lock
└── recovery/                    # 仅首次修复时创建，保留原件与修复清单
```

sessions 下只存会话 JSONL，锁单独放在 locks 下，不按项目或日期再建子目录。选择和过滤会话依赖 header.cwd；文件名不承担项目识别。v1 暂无 SQLite 索引或额外会话元数据 sidecar，列表展示与排序从 header 和日志取得；mtime 只能作文件变化线索，不能充当会话身份或事件顺序。

| 项目 | 推荐默认值与约束 | 理由或备选 |
| --- | --- | --- |
| 存储位置 | `~/.yucli/sessions/<timestamp>_<sessionId>.jsonl` | 集中保存，避免项目内日志混入 Git；项目 `.yucli/` 更便于随项目整理，但容易跟随仓库复制，本阶段不采用 |
| 应用根定位 | adapter 使用 homedir，bootstrap 可注入独立存储根供测试 | 存储位置不从模型配置或项目 .env 隐式改变；v1 不提供用户目录覆盖参数，测试使用显式注入 |
| sessionId | 新会话使用完整 UUID v4，推荐由 Node randomUUID 生成，写入 header 后保持不变 | 无需新增 UUID 库；时间戳供阅读，UUID 负责区分同毫秒创建的会话 |
| turnId | 每次接受普通用户输入生成新的 UUID v4；取消后的重试也生成新值 | 由应用协调方创建，经业务接口传给 core；core 不 import node:crypto |
| 文件名时间 | 使用创建时的 UTC ISO 时间，将 `:` 和 `.` 替换为 `-`；与 header.createdAt 来自同一次取值 | 恢复继续追加原文件，不改名、不重新生成 createdAt；校验和排序仍以 header 为准 |
| 已有文件身份 | 从受管文件名定位候选后，必须核对 header.sessionId；同一 ID 对应多个正文文件时拒绝写入 | 不按“最新修改”猜测真文件，不把复制文件自动认作新会话；新建时也检查 ID 未被占用 |
| POSIX 权限 | 新建 `.yucli/`、sessions、locks 为 0700；正文和锁文件为 0600，可受 umask 进一步收紧 | 已有受管路径必须为当前用户所有，且无组/其他用户权限；不合规时明确失败，不静默 chmod 无关路径 |
| 文件类型 | 受管数据目录及末端正文/锁必须符合预期类型，不跟随这些位置的符号链接写入；用句柄信息复核打开目标 | 不更改 home 本身的权限；这些检查不是抵御所有父目录替换的 OS 沙箱 |
| v1 持久化支持范围 | macOS arm64、Node 24.14.0、本地文件系统 | Linux、Windows、macOS Intel 及其他运行环境未验证，不宣称支持持久化创建/恢复；扩展前补安装、锁、权限及同步验证，不无锁降级 |

9.1–9.3 的 session-demo/turn-1 是讲解占位值；真实创建路径拟采用以上生成规则。持久化 schema 仍需校验非空身份及引用，不能只因某个示例 ID 不像 UUID 就忽略其事件关系。文件名与锁路径只能使用通过校验的身份，不能把任意用户输入直接拼入路径。

本地 sessionId 不是 OpenCodeGoClient 每次 HTTP 请求生成的 x-opencode-session 路由 UUID。后者继续按已有提供方契约生成；不能将持久化 sessionId 填入该路由头，也不在恢复时复用上次请求的路由 UUID。

#### 新会话何时真正产生文件

推荐 REPL 自动持久化，**第一次非空普通输入到来时才实体化会话**。启动帮助、版本、参数/配置失败、空行、只查看帮助，以及打开 REPL 后直接退出，都不创建新会话文件；会话列表为空时也不因列举而创建存储目录。这里的“不创建”指新会话流程，显式恢复已有会话可以在启动时打开它。

推荐 v1 的普通 `--prompt` 保留一次性、无会话文件的行为；9.1–9.4 的保存约束适用于启用持久化的执行路径。这是运行模式的候选范围选择，而不是保存失败后回退内存。备选是所有模式默认保存，但会增加脚本运行的文件与保留数据；若选择该方案，应同步 CLI 行为和测试，不能在实现中悄悄扩大。

首次输入的文件流程：

1. 完成参数和模型配置校验，取得固定的规范化工作目录；生成 sessionId、createdAt，准备路径。
2. 按约定权限创建必要目录，取得该 sessionId 的写入权；确认没有同 ID 正文，再以 `wx` 独占创建最终 JSONL 文件。发生 ID/路径碰撞时不得覆盖，最多重新生成身份尝试 3 次；其他 I/O 错误直接失败。
3. 写完整 header 并达到 9.4 的文件与目录确认点。目录已存在也不等于刚创建的文件名已持久化；新目录各级目录项一并纳入同步边界。
4. 创建本 turn 的 turnId，保存 seq=1 的 user 并等待确认，然后才发模型请求。后续事件继续使用同一写句柄。

header 与 user 不是一个原子事务。崩溃发生在二者之间，可能留下合法的 header-only 空会话；发生在 header 写到一半时，留下的文件不能恢复。既然尚未确认 user，就没有开始模型/工具操作；不为凑成“完整文件”伪造 user，也不覆盖遗留产物。创建或确认失败时不发模型请求，并进入存储失败流程。

#### 一份文件只允许一个写者

| 方案 | 行为与成本 | 本轮建议 |
| --- | --- | --- |
| 内核建议锁 | POSIX 平台可对固定文件取得非阻塞独占 flock，关闭描述符或进程终止后释放；本轮只验证 macOS arm64，Node 需要原生适配器 | **推荐**，满足崩溃后重新打开而不猜测锁年龄的需求 |
| 原子 mkdir/独占创建占位锁 | 可仅用 Node 标准库，但崩溃会遗留占位；自动接管还需要解决进程身份和删除竞态 | 无原生依赖的备选；若采用，v1 应冲突即拒绝、由操作者确认所有写者退出后清理，不能承诺自动崩溃接管 |
| 心跳加超时回收 | 长暂停或繁忙进程可能被误判死亡，恢复运行后形成双写 | 本阶段不采用；“超过 N 秒”不构成写者已退出的证据 |

锁适配器放在 adapters 中，推荐候选固定为 **fs-ext@2.1.1**。2026-10-26 已在独立临时目录使用官方 Node **24.14.0**、**darwin arm64** 安装并编译成功；项目 package.json、锁文件和 node_modules 未增加该依赖。官方 Node 包 SHA256 已按同源 SHASUMS256.txt 核对；主机默认 Node 26 没有用于本探针。

| 隔离验证项 | 实际结果 |
| --- | --- |
| 两个独立 Node 进程锁定同一稳定文件 | 后到者得到 EAGAIN/EWOULDBLOCK；不同会话锁互不阻塞 |
| flock 回调式异步 exnb | 持有者存在时拒绝；另一文件成功取得，不使用阻塞式 ex 等待 |
| 以只读句柄短暂取得 shnb | 能观察现有独占写者；空闲时能取得并关闭，不修改锁文件内容 |
| SIGSTOP 暂停持有者 | 仍然互斥，不因暂停而抢占 |
| 描述符关闭、进程保持存活 | 锁释放，后继可取得 |
| SIGKILL 强制终止持有者 | 等待进程退出后立即可重新取得，无过期计时；锁文件仍存在，dev/ino 未变 |
| 同进程独立描述符重复申请 | 后到者冲突，仍需应用句柄登记防止误用 |
| 当前测试文件系统的目录 fsync | Node 24 调用成功；这不等于已经验证断电耐久性 |

复验流程为：隔离 npm 包目录安装精确版本，用 process.execPath 启动持锁子进程，以 IPC 确认已持有后测试竞争，再分别关闭描述符、暂停/恢复和强制终止子进程；每一步等待明确结果后断言。测试仅使用临时锁文件，不调用模型或项目存储实现。**Linux、Windows、其他 Node 版本及 CI 构建环境未验证**；当前证据支持 Mac 候选选型，不能扩展为所有目标平台保证。将来声明支持 Linux 前必须补同类验证；安装/加载或行为验证失败是规格或发布的阻断条件，不能自动回退 mkdir、无锁或改变自动接管语义。上述备选仅供显式重新选型。

采用推荐方案时，所有写入方统一锁定 `locks/<sessionId>.lock`。锁文件正常释放后仍保留，**文件存在不代表仍有活动写者**；不按 PID、mtime 或文件年龄自动删除。保持同一锁文件 inode，取得锁后复核路径仍对应所持句柄；不能一边持有旧 inode 的锁，一边删除并重建同名锁文件。这样不需要为正常删除锁文件再引入 Codex 式全局协调锁。

写者从打开可写会话起持锁，覆盖 REPL 等待输入、整个 turn、保存和关闭；不能每个 turn 结束就释放锁，却保留可能已经过期的内存历史。单进程内部也只允许一个可写句柄，同一会话的事件仍按 9.4 串行写入。锁冲突立即报告会话正被占用，不忙等、不强制抢占；锁服务不可用也明确失败。此锁约束遵守同一协议的 yucli 写者，不约束外部编辑器，并且不承诺 NFS 等共享文件系统上的相同语义。

只读列举和诊断不打开可写会话、不修复正文；可对已有锁文件以只读句柄短暂申请 shnb 探测占用，随后立即关闭，不创建、删除或写入锁文件。本进程已经持有的会话直接查句柄登记。探测只描述当时状态，可能短暂与新写者竞争；用于恢复执行的历史始终要在正式取得独占写入权后重新读取，不能复用列表缓存或把探测成功当成写入许可。

#### 列表字段、状态与恢复入口

推荐 `yucli --sessions` 默认只列 header.cwd 等于当前 realpath 的会话；`--sessions --all` 是全局**只读列表**，其他 cwd 的记录标为“仅预览，需切换到原目录”，不能直接继续执行。损坏 header 导致 cwd 无法判定的文件不混入当前项目列表，汇总报告其数量，并在全局诊断列表中展示原因。

每行至少需要以下数据；字段属于内存读模型，不另存索引或回写正文：

| 字段 | 来源与规则 |
| --- | --- |
| sessionId、cwd、createdAt | 已校验的 header；短 ID 仅作显示，选择时歧义必须拒绝 |
| lastActivityAt、lastSeq、turnCount、lastTurnOutcome | 最近一条有效记录的 timestamp、seq、user 起点数量及最近 turn 的 outcome/推导中断状态；header-only 时间回退 createdAt，outcome 为空 |
| preview | 首条 user 的单行限长摘要，例如最多 80 个 Unicode 码点；不默认展示工具原文 |
| writerState | busy / available / unknown。分别表示探测到独占持有者、当时可取共享探测锁、无法可靠判断；锁文件不存在也记 unknown，不能凭此断言空闲 |
| logState | complete / interrupted / torn_tail / missing_lf / empty / corrupt / unsupported；来自 9.3 与 9.6 扫描，而非 writerState |
| observedAt、changing | 固定初始字节上限读取；前后 stat 变化或并发观察不稳定时标 changing，只展示已观察前缀，不标为完整快照 |
| resumability | yes / no / check_on_open，并附原因；其他 cwd、损坏、不支持或 busy 时 no，状态未知或变化时 check_on_open，最终以 openWrite 校验为准 |

logState 按 9.6 的明确映射生成：corrupt/unsupported 优先，其次是 torn_tail/missing_lf；tailKind=none 时，无 user 为 empty，存在任一缺少 turn_end 的 turn 为 interrupted，其余为 complete。complete 包含合法失败/取消/超时的已结束 turn，不表示全部执行成功。lastTurnOutcome 另行保留。writerState 和 logState 独立展示，例如 `busy · interrupted · 仅已观察前缀`；写者可能只是闲置持锁，不能把 interrupted 直接解释为进程崩溃。available 也只表示当次探测时刻，不能保证用户选择后仍然空闲。读到完整行也不能证明写者已经收到 fsync 确认；列表不展示“已耐久保存”的推断。

排序使用有效 lastActivityAt 降序，再按 createdAt 降序、sessionId 字典序打破并列；时间戳只影响列表展示，日志解释仍严格依 seq。默认隐藏 header-only 空会话，报告“已隐藏 N 个空会话”；全局诊断列表可见其 empty 状态。mtime 不决定排序，损坏/不支持条目单列，不按猜测时间插入正常列表。

候选入口固定为：`yucli` 新 REPL、`yucli --resume <sessionId>` 恢复 REPL、`yucli --sessions [--all]` 只读列举，以及闲置 REPL 的 `/resume <sessionId>` 切换。列表无需模型密钥；恢复仍需当前模型配置。`--prompt` 与 `--resume`/`--sessions` 不可组合，返回用法错误 2；不因恢复失败而悄悄新建会话。REPL 里选择当前会话是无操作，切换其他会话时先准备候选，成功后才关闭旧会话并替换历史。

#### 运行配置摘要与差异提示

v1 将 runtimeProfile 收敛为 **provider/model 两个字段**，只回答“历史由哪个提供方、哪个模型处理”。每条 user 的 TurnFact 外层都必须带该对象，adapter 按 9.7 原样写入 user JSONL 记录外层；不进入 Message，也不在其他事件重复，不从 SessionWriter 的隐藏配置上下文补字段。

| runtimeProfile 字段 | v1 含义与校验 |
| --- | --- |
| provider | 非空白字符串；当前 adapter 的稳定标识为 opencode-go，不用 API 地址替代 |
| model | 本 turn 实际选用的非空白模型标识，例如 deepseek-v4-flash；保存原值 |

v1 不新增独立 profile.version；它的解释由 header.formatVersion 管理。读取既有教学样例时允许整个 runtimeProfile 缺失并标为未知；对象存在时必须恰好包含合法的 provider/model 两个字符串字段，新写入的 user fact 则始终必填。若今后正式发布的格式需要扩展，再通过明确的版本兼容规则设计，不能重新解释已存字段。

例如同一 user 的业务事实与磁盘转换分别是（两段均为对象示例，不是两条重复消息）：

```json
{"type":"user","turnId":"turn-1","message":{"role":"user","content":"你好"},"runtimeProfile":{"provider":"opencode-go","model":"deepseek-v4-flash"}}
```

```json
{"seq":1,"type":"message","timestamp":"2026-10-27T02:00:00.000Z","turnId":"turn-1","runtimeProfile":{"provider":"opencode-go","model":"deepseek-v4-flash"},"payload":{"role":"user","content":"你好"}}
```

恢复时比较“即将进入上下文的最近成功 turn”的 provider/model 与当前值；没有成功 turn 时回退最近 user。不同则在恢复完成后、首次新请求前向 stderr 提示旧值和当前值一次；需要纳入上下文的记录缺摘要时，说明历史提供方/模型未完整记录，无法全部核对。提示不要求确认、不进入模型消息，后续请求和新的 user fact 使用当前配置。

当前项目只有固定只读工具，没有自动 system 消息，阶段 04 聚焦可靠保存和恢复对话。本次**移除 v1 的 endpoint/system/tools 指纹要求**：这些信息没有记录或比较，相同 provider/model 也不能宣称整个运行配置一致；端点、system 提示词和工具策略变化的检测、稳定序列化及行为版本维护留到有实际需求时设计。保留指纹是更强审计能力的备选，但会扩大本阶段格式与实现面，当前规模优先采用最小摘要。9.6 用于修复原件完整性核对的 sourceSha256 继续保留，与运行配置指纹无关。

#### 打开旧会话与 cwd 归属

工作目录候选规则与学习路线中“拒绝跨项目恢复”的边界一致：新建时记录启动 cwd 的 realpath 绝对路径；恢复时将当前 cwd 规范化后与 header.cwd **相等比较**。不是字符串前缀匹配，不自动扩大到 Git 根目录，也不把同一仓库的不同 worktree 当成同一工作目录。两个入口路径若 realpath 相同，可视为同一目录；目录迁移或重命名不自动修改 header 归属。

恢复执行的最低流程为：

```text
从用户选择定位受管会话
  → 取得该 sessionId 的写入权
  → 重新打开正文并完整校验 header、seq、事件和 cwd
  → 按 9.6 的字节边界备份、修复并同步未完成尾部
  → 从有效文件重建历史、最后 seq 和工具状态
  → 开始新的 turn，继续在原文件追加
```

未通过格式或 cwd 检查时释放本次资源，正文不改动，不发模型请求，不自动创建一份同名新会话。resume 使用不创建文件的 r+ 打开既有正文，不能用 a+ 将不存在的目标意外创建为空文件。尾部修复必须完成 9.6 的备份与同步后才能写新 user；读预览不修复原件。

恢复后保留 sessionId、createdAt 和原文件名；新 turnId 重新生成，seq 从有效记录的最后值加 1，header-only 会话从 1 开始。旧 turn 缺少 turn_end 时仍按 9.3 推导 interrupted，不补写旧终止记录；接下来的 user 属于新的 turn。read_file 的根目录与该规范化 cwd 一致；当前 .env 和模型配置仍来自启动环境，不依据历史内容自动切换目录或加载其他项目的凭证。

#### 运行、清空历史与关闭的边界

会话资源状态与 9.3 的 turn outcome 分开，由协调方及存储句柄在内存中维护，不追加进 JSONL：

| 资源状态 | 含义与允许动作 |
| --- | --- |
| 待创建 | 没有文件句柄；可接受首次输入或直接退出 |
| 打开中 | 正在取得写入权、创建/校验并准备正文；禁止开始模型或工具执行 |
| 可写 | 拥有锁和已验证的文件前缀；按确认顺序接受新 turn 与追加 |
| 故障 | 保存或所有权失败已被记录；禁止新执行与追加，只允许报告和收尾 |
| 关闭中 / 已关闭 | 拒绝新操作；关闭完成后如需恢复，重新打开并校验，不复活旧句柄 |

故障原因与最后确认 seq 在收尾后仍保留给错误报告；关闭资源不能把先前故障改判为保存成功。正文/锁句柄、资源状态和确认游标都不是需要重复持久化的会话事件。

| 时机 | 候选行为 |
| --- | --- |
| 普通成功 turn | 等 turn_end(success) 确认后提交模型历史，继续持锁等待输入 |
| 模型失败、取消或超时 | 若非成功 turn_end 已确认，继续等待下一次输入；未完成 turn 不进入模型历史 |
| 写入、同步、锁所有权或关闭失败 | 会话进入故障状态，停止消费后续输入和开始新操作，报告存储错误后收尾退出；不继续当成普通模型错误处理 |
| `/clear` | 关闭当前会话并释放写入权，清空上下文，转为待创建的新会话；下次真实输入使用新 sessionId。关闭失败则按存储故障退出 |
| `/exit`、`/quit`、EOF、闲置 Ctrl+C | 停止接受输入，等待已接受 turn 的执行与保存收尾，关闭文件并释放写入权；不开启新 turn，不额外追加 session_end |
| 进程被强制终止 | 不保证有执行 finally 的机会；后继进程依据有效文件恢复，内核释放已消亡写者的锁，不自动重跑工具 |

`/clear` 的推荐语义保留“下一次请求不带旧上下文”的体验，但不删除既有记录。若只清空内存却继续写同一日志，恢复时可能重新带回用户已经清掉的上下文；备选是在原文件增加 context_reset 事件，本阶段优先选择新会话，避免扩大 v1 格式。命令帮助与提示需说明旧会话保留、可被显式再次选择。

最近 20 个成功 turn 是模型上下文的窗口，不是磁盘保留期限。v1 不因内存裁剪而重写 JSONL，不自动清理历史；删除命令、归档、压缩和配额暂不纳入本节推荐的第一版。用户需要删除时，在所有写者退出后离线删除对应正文；锁文件可以保留，不在活动写者期间手工删除。0600 不等于内容脱敏或加密，会话可能保存用户输入和工具读取的敏感文件原文，不能声称删除本地文件也会清除外部备份。

关闭由持有会话的应用协调方负责，存储 adapter 持有正文句柄、锁句柄和最后确认 seq；core 不操作这些资源。close 必须可重复等待，第一次就禁止新 append，完成已开始的文件操作、必要同步和正文关闭后再释放锁；即使关闭报错，也应在没有未决写入后尝试释放资源，并保留失败报告。存储等待超时不等于底层 I/O 已取消，不能因为计时器到期就释放锁，让后继写者与仍在完成的旧操作竞争；挂起操作的退出策略需在规格中给出可验证的界限。

推荐新增稳定的 SessionAccessError 与 PersistenceError，使用不同 code 表达访问拒绝和保存故障；退出码 5 统一表示会话操作未完成，**不等于所有此类错误都已丢失数据**。错误携带安全的 operation、code、message，必要时带 lastConfirmedSeq、文件行/字节位置；不以原始 Error.message 回显用户内容。

| 错误/场景 | CLI 与 REPL 行为 |
| --- | --- |
| session_busy：候选会话锁冲突 | `--resume` 启动失败退出 5，说明“未取得写入权，未修改正文”；REPL `/resume` 保留健康旧会话与历史，显示原因后允许重新选择/重试，不把旧写者标为故障 |
| not_found、cwd_mismatch、unsupported、corrupt：候选不可打开 | 启动恢复退出 5；交互选择失败保留旧会话。语义损坏仍拒绝整个候选文件，不能跳过坏 turn |
| platform_unsupported：不在 v1 已验证持久化支持范围 | 启动创建/恢复在文件副作用前以 5 拒绝；不绕过检查尝试无锁执行；普通 --prompt 不因此触发持久化平台检查 |
| lock_unavailable：原生库加载/内核调用不可用 | 独立错误码，区别于 busy；启动退出 5，REPL 禁止进入新的持久化执行并收尾退出，不降级无锁 |
| write_failed、sync_failed、repair_failed、ownership_lost、close_failed | PersistenceError；停止新执行，等待未决 I/O 与清理后退出 5。repair_failed 也不能继续发模型请求，即使截断实际上已完成 |
| 普通模型/工具失败、取消、超时 | 终止记录保存成功时仍按阶段 03 处理；REPL 可继续，普通单次模式返回 4 |

访问冲突不是“当前会话保存失败”，所以不应一律结束交互 REPL；真正存储故障也不能被宽泛 catch 后继续。已有用法 2、配置 3 保留。正常关闭保留 0/130 等语义；保存/关闭失败优先报告 5。模式范围也应明确出现在帮助与规格中：**v1 自动持久化只覆盖 REPL，包括显式恢复；普通 --prompt 不持久化，且不能与恢复参数组合**。

原生锁能力在进入持久化创建/恢复路径并通过环境检查后加载；help/version 和普通 --prompt 不因锁库不可用而提前失败。只读列表若不能探测写者状态，按 unknown 展示，不据此授予恢复执行权限。

#### 累积产物、备份与删除的明确边界

header-only 空会话、创建失败留下的产物、永久锁文件与修复备份都会累积，这是 v1 的已知限制。正常列表隐藏空会话但报告数量；locks 下文件数量不表示活动写者数量，不能作为“僵尸进程”指标。9.6 仅为实际修复创建 recovery 备份，完整健康文件恢复不产生备份。

v1 不提供自动保留期限、删除/归档命令、锁文件垃圾回收或备份自动恢复；这些属于明确非目标。手动清理必须在所有相关写者退出后操作：删除正文不会删除 recovery 原件，应按备份清单中的 sessionId 一并决定保留或删除；稳定锁文件可保留。若确需删除锁文件，必须保证没有持有者及并发打开者，不能在运行中 unlink。损坏正文和备份默认保留，不自动“修复”语义损坏。将来引入删除或归档功能必须设计独占协调、正文与备份处理、目录同步及中途失败恢复，不能仅追加一个 rm；本阶段不预设其实现。

#### 既有代码调整、兼容影响与验收

| 位置 | 现状及限制 | 候选变化 |
| --- | --- | --- |
| bootstrap/cli.ts | 只组装模型与只读工具，两种模式都没有会话资源 | 组装存储与协调对象，分开列表、恢复和单次模式；列表不加载模型密钥，保留 help/version/参数错误在文件副作用前结束 |
| bootstrap/repl.ts | turns 从空数组开始，`/clear` 只替换数组，所有 turn 异常后都继续 | 接收恢复的有效历史与会话能力；clear 关闭旧会话、下次输入惰性创建；存储故障终止循环；finally 覆盖会话关闭 |
| bootstrap/output.ts | displayTurn 兼顾调用 core 与输出，reportError 没有存储分类 | 文字显示与会话协调分工需显式化，增加安全存储错误输出/退出映射，保持 stdout 只输出原有用户内容 |
| core/runTurnStream.ts 与 contracts | 当前仅完整成功返回，core 不依赖 Node；还没有可等待的保存事实交付 | 按 9.7 的 CoreTurnFact/TurnFactSink 交付并等待；协调方唯一负责 user/turn_end；core 不依赖文件 seq |
| 新存储 adapter 与存储配置 | 当前只有模型 RuntimeConfig，没有会话文件管理 | 分离存储配置，新增 runtimeProfile 摘要、扫描/备份修复及业务引用映射；UUID/时钟/锁在外层组合，便于临时目录验证，不保存模型密钥 |
| CLI/REPL 契约与架构文档 | 描述阶段 03 的纯内存行为 | 阶段 04 规格固定模式、列表状态、配置提示、锁/修复错误、clear 和提交边界，再同步契约、架构及必要 ADR；本轮不改 accepted 契约 |

目前没有 yucli 会话文件需要迁移；进程内消息和工具结果的含义沿用 9.2。与阶段 03 相比，REPL 默认持久化、clear 切换会话、存储故障退出是需要公开说明并验证的变化。原有单次模式、模型请求路由与正常取消行为不因存储实现而隐式改变。

形成规格后的验收至少覆盖：

- 在隔离 home/临时存储根中，帮助、参数失败、空 REPL、空行和普通单次模式不创建会话；首次 REPL 问题产生一个合法文件，后续问题追加同一文件。
- 同毫秒创建两份会话不冲突；注入 ID 碰撞时不覆盖；文件名/header ID 不一致或同 ID 多文件时拒绝写入；目录、正文与锁的类型和 POSIX 权限符合约定。
- 两个独立进程同时打开同一会话，最多一个可写，另一个明确冲突；不同会话互不阻塞；idle 写者仍持锁。强制终止持有者后可重新取得锁，锁文件保留不阻止接管；暂停但未退出的写者不能被超时抢占。
- 同 cwd 的新进程恢复后，真实适配器发出的请求含有效旧历史和新输入；不同 cwd、父子目录或不同 worktree 拒绝恢复。同一真实目录的符号链接入口遵循规范化规则；不自动重跑旧工具。
- clear 后新请求不带旧历史，新 sessionId 与文件独立；显式再打开旧会话仍能看到原记录；20-turn 内存窗口不裁剪磁盘原文。
- 默认列表只含同 cwd，global 列表的其他 cwd 只能预览；空会话计数、排序并列、busy/unknown/changing 与尾部状态独立显示，探测之后发生的竞争仍由正式 openWrite 拒绝。
- 提供方或模型变化时提示一次并使用当前配置；缺摘要明确未知；同 provider/model 不能显示“全部配置一致”，端点、system、工具变化不在 v1 比较范围。新 user fact 外层包含摘要，原 Message 不变，提示不进入模型。
- `--resume` 锁冲突退出 5，REPL 切换冲突保留旧历史并允许重试；锁不可用与 repair_failed 为独立原因，禁止无锁降级；普通 --prompt 不创建文件，与恢复组合返回 2。
- 验证 start 确认后的取消阻止注册表调用，记录 cancelled_before_dispatch；仅有 start 的崩溃前缀仍为 unknown。逐项检查 9.6 的 tailKind/logState 映射，以及未验证平台在持久化文件副作用前拒绝。
- 在创建、header/user 确认、追加、关闭和锁阶段注入失败，不发起被屏障阻止的外部操作，不继续消费后续 REPL 问题，不误报成功。关闭重入、EOF、活动取消和闲置中断时无句柄/锁泄漏，保存失败与退出码优先级一致。

本轮验证文档及隔离目录中的锁候选；9.5 的锁验证结果单独列明。以上应用级验收仍待实现，不能将依赖探针通过写成 yucli 持久化已实现。

源码依据：[CLI](../../src/bootstrap/cli.ts)、[REPL](../../src/bootstrap/repl.ts)、[输出与退出分类](../../src/bootstrap/output.ts)、[配置读取](../../src/adapters/config/loadConfig.ts)、[提供方请求路由](../../src/adapters/opencode-go/OpenCodeGoClient.ts)、[四层依赖约束](../../tests/architecture.test.ts)、[Pi 会话创建与写入](../../../references/pi/packages/coding-agent/src/core/session-manager.ts)、[DSH 会话句柄](../../../references/dsh/packages/session/session-persistence/src/handle.ts)、[DSH 内核锁](../../../references/dsh/packages/session/session-persistence-jsonl/src/lease.ts)、[Codex 写者锁](../../../references/codex/codex-rs/rollout/src/writer_lock.rs)、[ZCode runtime 接入](../../../references/zcode/apps/zcode-cli/docs/design/v2/session-persistence.md)。

### 9.6 字节扫描、只读恢复与尾部修复

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选算法，未实现**。9.3 的投影与拒绝粒度继续适用，本节将“可忽略未完成尾行”具体化为可执行的扫描与写入准备步骤。

#### 扫描必须给出字节位置和分类

读取器在打开的普通文件句柄上取得初始大小 S，只读取 `[0,S)`，按字节 0x0A 划分物理行，用严格 UTF-8 解码，不用 JavaScript 字符串 length 推算文件偏移。每个换行结束的行都必须依次通过 JSON、schema 与 9.3 语义校验；不跳过空行或中间坏行。header 无效时直接拒绝，没有可恢复空会话。

扫描结果至少包含 source 的 dev/ino、observedSizeBytes、validEndBytes、lastLfEndBytes、lastSeq、tailKind 和首个诊断位置。validEndBytes 是可解释的有效字节范围的**右开边界**，不是完整成功 turn 的边界；业务投影再按 9.3 选择成功 turn。

| 最后部分 | 只读结果及边界 | 可写准备 |
| --- | --- | --- |
| 全部行有效且有末尾 LF | tailKind=none，validEndBytes=S | 不改正文，不创建修复备份 |
| 无 LF 的最后一行是完整合法记录 | missing_lf，validEndBytes=S，保留该记录并计入 lastSeq | 保留原字节，在偏移 S 补一个 LF，再同步；不能删掉这条记录 |
| 最后一行无 LF，且确为尚未完成的 JSON/UTF-8 前缀 | incomplete，validEndBytes=P，其中 P 是上一条有效行 LF 后的字节位置；记录残片范围 `[P,S)` | 先保全原件，再 truncate(P)，同步并重验 |
| 完整 JSON 但 schema/引用/seq/outcome 不合法 | corrupt；整个文件不可恢复执行，即使错误恰在 EOF | 不截断、不补事件；只读报告原因 |
| 明确非法语法/UTF-8、中间坏行或换行结束的坏行 | corrupt；整个文件拒绝 | 不以尾部策略跳过或拼接历史 |

例如 `{"seq":6,` 可以继续补成合法 JSON 对象，是未完成前缀；`{"seq":6,}` 已有非法语法，不能仅因缺 LF 就忽略。`{"seq":6}` 是完整 JSON，但缺少事件必填字段，属于 schema 损坏。success 缺结果、无 start 的 result 均是语义损坏，不能降为 interrupted。无法分类时采取拒绝，不能猜测。

实现需要一个与严格 UTF-8 解码配合的 JSON 前缀识别器，输出 complete/incomplete/invalid：跟踪对象/数组、键值阶段、字符串转义、Unicode 转义、数字与字面量；只有“存在合法后缀能补成一个 JSON 对象”才算 incomplete。不能匹配不同 Node 版本的 JSON.parse 错误文字，也不能只判断括号数、引号数或最后一个字符。完整值仍交给 JSON.parse 和 schema/语义校验，前缀识别器不替代业务校验。

只读打开不改文件，返回有效前缀及尾部诊断。对活跃写者的列表读取，扫描边界 S 可能正好切在一次追加中；标注 busy/changing 和“仅已观察前缀”，不把这次观察当成可写恢复结果。写恢复取得独占后必须重新读取并分类，旧偏移、mtime 或列表缓存都不能授权截断。

#### tailKind 到列表 logState 的映射

先检查格式/语义拒绝条件，再应用物理尾部优先级，最后检查 turn 完成状态：

| 扫描或事件证据 | logState |
| --- | --- |
| header.formatVersion 不支持 | unsupported；不把它当作尾部残片 |
| JSON/schema/引用/顺序等损坏 | corrupt；不返回可用于恢复的正常 ScanResult |
| tailKind=incomplete，且此前有效前缀成立 | torn_tail |
| tailKind=missing_lf，最后记录完整合法 | missing_lf |
| tailKind=none，只有合法 header、没有 user | empty |
| tailKind=none，存在任一缺少 turn_end 的 turn | interrupted |
| tailKind=none，存在 user，且所有 turn 都有合法 turn_end | complete；允许 failed/cancelled/timeout，不等于全部 success |

因此 none 不直接等于 complete，“文件里有 turn_end”也不足以证明所有 turn 已结束。旧 interrupted turn 后追加的新 turn 即使成功，旧中断事实仍保留，logState 为 interrupted、lastTurnOutcome 可以为 success；这不妨碍按 9.3 恢复有效历史，也不要求补写旧终止记录。writerState 仍独立判断是否活跃，不能由 interrupted 推断持有者已死亡。

#### 修改前保全原件，修改后确认同步

推荐在需要 truncate 或补 LF 时保留**完整原文件快照**，从而同时保留有效前缀和残片；只保留尾部更省空间，但恢复时依赖前缀仍在，本阶段优先完整原件。普通健康恢复没有备份副作用。

写恢复在持锁状态下依次执行：

1. 以 r+ 打开既有正文，复核路径/句柄身份、权限、cwd、格式和固定范围内全部记录；得到 S、P/validEndBytes、lastSeq 及源 SHA-256。未通过则只释放资源，不修改正文。
2. 在 `~/.yucli/recovery/<sessionId>/` 下用唯一时间戳和 UUID、wx 创建 `.jsonl.bak` 原件及 `.repair.json` 清单，目录 0700、文件 0600；复制恰好 `[0,S)` 并核对字节数和摘要，不用读取字符串后重新序列化代替字节复制。
3. 对备份与清单分别 fsync，再同步 recovery 下必要目录项。两者成功之前**绝不修改原件**。备份失败可能留下未完成产物，保留作诊断；没有完整清单及匹配摘要时不能当成可自动还原的备份。
4. 在修改前再次核对来源身份、大小及摘要仍相符。若被替换或变化，停止并报告，不使用旧边界。该检查依赖所有 yucli 写者遵守同一锁协议，不宣称能隔离不遵守协议的外部编辑器。
5. incomplete 时对同一正文句柄执行 truncate(P)；missing_lf 时只在偏移 S 写入一个 LF。立即对正文 fsync，再读取并重验实际文件为连续、换行完整的有效日志；不更新原有 JSON 内容或补写旧 turn_end。
6. 上述步骤全部确认后，才把句柄标为可写，并允许以 `lastSeq + 1` 追加新的 user。只读扫描里的有效终止事实不因修复而改变；成功 turn 才进入模型，旧未完成 turn 仍是 interrupted。

清单最少包含 version、sessionId、sourceBasename、createdAt、action、originalSizeBytes、validEndBytes、lastSeq 和 sourceSha256。以下字节数来自本报告 9.3 的崩溃前缀（最后 seq=5，保留末尾 LF），再追加 29 个 ASCII 字节 `{"seq":6,"type":"tool_result"`；不含运行配置摘要的教学例子仍按原字节计数：

```json
{"version":1,"sessionId":"session-demo","sourceBasename":"example.jsonl","createdAt":"2026-10-26T02:00:00.000Z","action":"truncate_tail","originalSizeBytes":1158,"validEndBytes":1129,"lastSeq":5,"sourceSha256":"5b2bd4ab47d68aae3868d921ba36112c45b74acaca03036303e45c8b24f08c07"}
```

这个例子只读保留 `[0,1129)`，备份完整 `[0,1158)`，写恢复截到 1129 并 fsync，新 user 的 seq 为 6。UTF-8 中文已按字节计入，不能用可见字符数代替。若只是合法最后记录少 LF，action 为 append_lf、validEndBytes=S，修复后大小是 S+1，lastSeq 不变。

修复不是整文件原子事务：崩溃可能发生在备份完成前、truncate 后或正文 sync 后。下次仍检查实际文件，不能仅凭清单就自动回滚或重放；完整合法原件不再重复备份，已有备份永久保留直到离线清理。备份自动恢复、语义损坏修复、档案轮换和备份保留期限均不在 v1 范围。

#### 失败时能否继续、何时释放锁

读取或备份失败时不执行截断；truncate/补 LF/sync/重验失败时视为正文结果不确定，抛 repair_failed，**不写新 user、不发模型请求、不继续该 REPL**。先禁止新操作，等待已发出的文件操作全部结束，再关闭正文及备份句柄，最后释放锁并退出 5；可以释放锁，不等于宣称修复已成功。若 I/O 仍未决，等待超时也不能提前释放锁，需按明确的进程收尾策略结束，让进程真正退出后由内核释放。

下次打开按实际字节重新校验：可能是原残片仍在、已经截好但上次未收到确认，或仍不能恢复；不盲目重试同一写入。新建路径的目录确认仍按 9.4；原件仅原位 truncate/补 LF 时，正文 fsync 是必要步骤，不虚构需要替换正文目录项的操作。

对应验收要覆盖 UTF-8 多字节截断、字符串/转义/数字的未完成与非法前缀、完整非法尾事件、缺 LF 的合法记录、只读不变、备份失败零修改、各修复步骤失败及二次打开；边界和 SHA 使用实际字节断言，不只测试最终 Message[]。

### 9.7 core/storage 的有序业务接口与历史提交

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选接口，未修改 contracts 或源码**。本节将 9.3–9.4 的等待和关联规则具体化，仍由阶段规格评审后再实现。

#### 业务事实的形状和唯一所有者

推荐 coordinator 创建 user、选择唯一 turn_end；core 只交付已经校验的 assistant 和工具事实。这样业务异常和存储异常的收尾不会各自写一条结束事件。接口示意使用现有 TextMessage、AssistantMessage、ToolResult；SafeError 对应 9.3 的安全错误对象：

```ts
type SafeError = {
  category: "model" | "tool" | "protocol" | "limit" | "cancellation" | "timeout" | "internal";
  code: string;
  message: string;
  httpStatus?: number;
};

type FailureEnd = { outcome: "failed" | "cancelled" | "timeout"; error: SafeError };
type TurnEnd = { outcome: "success"; error?: never } | FailureEnd;

// 仅在本 turn 内关联已校验响应；不等于文件 seq 或模型给出的 toolCallId。
type CallRef = { assistantId: string; toolCallId: string; name: string };

type CoreTurnFact = { turnId: string } & (
  | { type: "assistant"; assistantId: string; message: AssistantMessage }
  | { type: "tool_start"; call: CallRef }
  | { type: "tool_result"; call: CallRef; result: ToolResult }
  | { type: "tool_end"; call: CallRef; end: FailureEnd }
);

// coordinator 创建，user fact 外层保存；不扩展 Message 或 core 的工具事实。
type RuntimeProfile = { provider: string; model: string };

type TurnFact = CoreTurnFact | ({ turnId: string } & (
  | { type: "user"; message: TextMessage & { role: "user" }; runtimeProfile: RuntimeProfile }
  | { type: "turn_end"; end: TurnEnd }
));

// coordinator 为持久化运行注入；解析、顺序与所有权校验失败都应拒绝 Promise。
interface TurnFactSink {
  record(fact: CoreTurnFact): Promise<void>;
}

// runTurnStream 增加可选执行上下文参数；普通 --prompt 不传此对象。
interface TurnExecutionContext {
  turnId: string;
  facts: TurnFactSink;
}

// adapter 实现；分配 timestamp/seq、映射引用，并原样保存 user fact 的 runtimeProfile。
interface SessionWriter {
  appendDurable(fact: TurnFact): Promise<{ confirmedSeq: number }>;
  close(): Promise<void>;
}
```

type 是 TypeScript 判别联合，运行时 JSON 仍需校验。core 每次交付前已完成流收尾、整批参数预检与结果结构检查；adapter 校验并快照传入数据，避免等待期间被修改。user 的 runtimeProfile 由协调方构造在该条 TurnFact 外层，appendDurable 直接接收完整事实，adapter 校验并复制到 JSONL envelope，既不从构造器闭包补齐，也不自行读取模型配置；timestamp 由注入时钟在创建记录时取值。接口不携带原始 Error、SSE delta、文件句柄或 API key。

本节的 callback 是有序、可等待的**业务事实边界**，不是任意监听器：同一 turn 不并发 record，不允许 fire-and-forget；Promise 拒绝必须停止后续副作用，保存与普通展示监听器不能混为一个可忽略错误的事件总线。

#### assistantId 怎样变成 callMessageSeq

core 对每个有效 assistant 响应生成 turn 内递增的 `a1`、`a2` 等临时 assistantId，包括最终无调用响应。它只区分业务响应，不推测文件位置；相同 ID 可以出现在另一 turn。磁盘仍只保存 9.1–9.3 的字段，不新增 assistantId。

adapter 持有 `(turnId, assistantId) → 已确认 assistant seq` 映射。保存 assistant 时分配 seq，完整写入并同步成功后才登记映射；tool_start/result/end 用同 turn 的 CallRef 查询，再验证该响应中的 ID、name 和结果字段一致，转换成 callMessageSeq。未知引用或重复 assistantId 是契约错误，不能猜测“最近一个 assistant”。

| 业务事实 | 磁盘转换 |
| --- | --- |
| turn-X 的 a1，seq=2，含 call-1 | 登记 `(turn-X,a1) → 2` |
| a1/call-1 的 start、result，seq=3/4 | payload.callMessageSeq=2 |
| 同 turn 的 a2，seq=5，再次含 call-1 | 独立登记 `(turn-X,a2) → 5` |
| a2/call-1 的 start、result，seq=6/7 | payload.callMessageSeq=5，不会与 a1 的结果串配 |

只允许先保存调用消息再保存 start，正常结果仍只保存一份。已确认 turn_end 后释放该 turn 临时映射；打开旧文件时依据磁盘引用校验和投影，不需要重建旧的 a1/a2，因为不会继续旧执行。sync 失败时不登记本次映射，writer 进入故障状态；文件里可能已存在完整记录，后续只能重新打开校验，不能在原 writer 上重试相同 seq。

#### await、错误传播与 REPL 提交

持久化路径的调用顺序为：

```text
coordinator: await writer.appendDurable(user fact，外层含 runtimeProfile)
  → core: await sink.record(assistant)
  → core: await sink.record(tool_start)，再检查取消
  → 若已取消：await sink.record(tool_end(cancelled_before_dispatch))，抛取消并直接转协调方收尾
  → 否则进入注册表：await sink.record(正常 tool_result 或异常 tool_end)
  → 正常工具结果齐全才继续模型；最终 assistant 确认后 core 返回临时结果
  → coordinator: 固定唯一 outcome，await writer.appendDurable(turn_end)
  → 仅 success 的确认成功后，返回“可提交历史”的结果给 REPL
```

sink 的桥接实现是 `async record(fact) { await writer.appendDurable(fact); }`，故 confirmedSeq 不进入 core。appendDurable 正常返回表示该记录及之前前缀完成 9.4 确认；排队成功或 write 回调不满足接口。等待返回后、继续外部操作前检查取消，已经取得的完整 ToolResult 则先保存，避免把已知结果丢掉。

普通模型/工具错误由 core 保留已交付事实后向上抛；协调方映射 failed/cancelled/timeout 并保存唯一 turn_end，再报告原业务原因。取消在终止选择前参与 outcome 决定，选择后不追加第二个 turn_end。终止写入使用独立收尾上下文，不复用已取消 signal。

PersistenceError 必须原样穿过 core 和注册表，不能被包装成 protocol_error、普通 tool_result(ok:false) 或取消。writer 对非法本地引用或顺序等契约违规也以 PersistenceError(contract_violation) 拒绝，写入前校验失败不追加非法记录，但当前执行仍须停止；这与模型输入的协议错误不同。保存 await 应放在工具 execute 的业务异常 catch 之外，避免记录保存失败又触发 tool_end 的递归保存。协调方发现 PersistenceError 或 writer 已故障时不再尝试向该 writer 写 turn_end，只清理并以 5 退出；不能把故障本身“保证写回”故障文件。

core 的 StreamTurnResult 仍是**临时业务成功结果**，不是历史提交凭证。REPL 只消费协调方在 turn_end(success) 确认后交付的结果，再将完整 appendedMessages 作为一组加入最近 20 个成功 turn；返回值里的 user/tool 消息不再次落盘。失败、取消或终止保存失败时不提交。恢复与实时运行使用同一 ToolResult→ToolMessage 转换，磁盘事实和显示/模型视图保持分离。

普通 --prompt 路径不注入持久化 sink，继续由 core 的临时成功结果完成单次输出；它没有“已保存”凭证，也不能因不持久化而绕过原有工具校验/取消边界。该显式模式选择与存储失败后的降级不同。

对应实现需修改 runTurnStream、executeToolBatch/RegisteredTools 的逐项交付与取消检查，新增 coordinator、contracts 接口及 adapter 转换；保留现有返回视图以减少兼容变化，但不得继续依靠整批成功数组作为唯一事实来源。验收应通过延迟/拒绝每个 appendDurable 检查副作用屏障、两个批次复用 ID、非法本地引用、普通异常与存储异常分类、取消竞态，以及 turn_end 确认之前 REPL 历史不变。

参考依据仍是 9.2 的现有业务类型、9.3–9.4 的状态与确认约束，以及 DSH 对 append 接受和 flush 耐久边界的区分；不照搬其可后台缓存的 append 语义，本候选直接将业务写接口命名为 appendDurable，减少误用。

本轮已在临时文件中提取本节类型声明，引用当前 message/tool 类型并用项目 TypeScript 的 strict、noEmit 校验通过；这只验证候选声明能与现有类型组合，不代表运行时顺序、保存或错误传播已经实现。JSONL 示例、9.6 的字节数/摘要、本地链接与 git diff 检查均已复核，未重跑业务测试或真实模型请求。

### 9.8 阶段 04 的五项范围收敛

讨论日期：2026-10-27（Asia/Shanghai）。状态：**本轮推荐取舍，供用户评审；尚未成为阶段规格或实现**。本节只汇总五项决策，具体约束已同步到对应小节，不增加新的存储机制。

| 决策 | 本轮推荐 | 对应约束与取舍 |
| --- | --- | --- |
| runtimeProfile 放哪 | coordinator 构造在 user TurnFact 外层；SessionWriter 接收完整事实，adapter 复制到 user JSONL 外层 | 9.3 事件表、9.5 示例及 9.7 类型一致；不扩展 Message，不依赖 writer 隐藏配置 |
| start 后、分派前取消 | tool_end(cancelled)，error.code=cancelled_before_dispatch | 仅明确没有调用注册表时使用；恢复有合法终止事实则已知取消，仅剩 start 则 unknown |
| tailKind 与 logState | 采用 9.6 映射表：incomplete→torn_tail、missing_lf→missing_lf，none 再按空会话和各 turn 终止证据分类 | complete 是日志完成状态，包含已终止的失败/取消/超时，不代表业务全部成功；writerState 独立 |
| runtimeProfile 的 v1 范围 | 只存 provider/model；移除 endpoint/system/tools 指纹及独立摘要版本字段 | 能提示提供方/模型变化，无法检测其余配置变化；修复备份的 sourceSha256 保留，不属于此精简范围 |
| v1 支持平台 | 持久化创建/恢复只支持 macOS arm64 + Node 24.14.0 + 本地文件系统 | 与已完成锁探针的范围一致；其他平台明确拒绝持久化执行，验证后再扩展，不自动改锁机制 |

完整调用场景、验收矩阵与实现任务在阶段规格中汇总，沿用本章现有示例和失败边界，不再为相同决策另增调研机制。当前锁探针证据不等于应用已实现；现有代码和 accepted 契约仍待阶段 04 实现时同步。

## 10. 本阶段建议的评审问题

以下问题作为逐步讨论的提纲，不预设实现方案；先从实际存储格式的数据结构开始。

1. 一个会话文件具体长什么样？若采用 JSONL，header 与后续每行分别保存什么，如何用完整文件示例说明？
2. 消息、工具调用/结果与生命周期事件分别怎样表达？需要哪些 ID、顺序和时间字段，各字段解决什么问题？
3. 怎样标识一个 turn 的开始和结束？失败、取消、超时和中断的记录怎样恢复，哪些内容进入下一次模型请求？
4. 用户输入、模型输出和工具结果在什么时机保存？append、flush、fsync 和保存失败分别如何处理？
5. 会话目录、文件命名和权限怎样确定？
6. 用户通过什么入口新建、选择和恢复会话？cwd 过滤规则怎样确定？
7. 同一会话允许几个写者？并发与冲突怎样处理？
8. 格式版本、未知事件、坏行和顺序异常分别怎样处理？
9. compaction、分支和树导航是否进入阶段 04，还是留到后续阶段？
10. 会话内容的隐私、备份、删除和保留策略怎样确定？

按讨论结果逐步补回第 9 章，再形成阶段规格和接口契约。

## 11. 资料索引

### Pi

- `references/pi/packages/coding-agent/docs/session-format.md`
- `references/pi/packages/coding-agent/docs/sessions.md`
- `references/pi/packages/coding-agent/docs/compaction.md`
- `references/pi/packages/coding-agent/src/core/session-manager.ts`
- `references/pi/packages/coding-agent/src/core/agent-session.ts`

### ZCode

- `references/zcode/apps/zcode-cli/docs/design/v2/session-persistence.md`
- `references/zcode/apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`
- `references/zcode/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`
- `references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts`
- `references/zcode/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`

### DSH

- `references/dsh/docs/persistence-catalog.zh.md`
- `references/dsh/docs/session-format-status.zh.md`
- `references/dsh/packages/session/session-format/README.zh.md`
- `references/dsh/packages/session/session-format/src/types.ts`
- `references/dsh/packages/session/session-format/src/chain.ts`
- `references/dsh/packages/session/session-persistence/src/storage-contract.ts`

### OpenAI Codex CLI

- `references/codex/codex-rs/rollout/src/recorder.rs`
- `references/codex/codex-rs/rollout/src/compression.rs`
- `references/codex/codex-rs/rollout/src/model_context.rs`
- `references/codex/codex-rs/rollout/src/metadata.rs`
- `references/codex/codex-rs/tui/src/session_resume.rs`
- `references/codex/codex-rs/history/src/compaction_resume_metadata.rs`

### OpenCode

- `references/opencode/specs/v2/session.md`
- `references/opencode/packages/core/src/session/sql.ts`
- `references/opencode/packages/core/src/session/projector.ts`
- `references/opencode/packages/core/src/session/history.ts`
- `references/opencode/packages/core/src/session/compaction.ts`
- `references/opencode/packages/schema/src/session-message.ts`
