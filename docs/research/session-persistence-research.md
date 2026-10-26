# 阶段 04：会话持久化调研报告

状态：`research-draft`

调研日期：2026-10-20（Asia/Shanghai）

补充日期：2026-10-20（Asia/Shanghai）

变更记录：补正参考快照 commit；补充单写者、落盘成功语义、v1 事件/replay、目录恢复、版本/未知事件、坏行、隐私保留和失败 turn 边界；扩充评审问题。

评审修订：2026-10-25（Asia/Shanghai）。统一文件 header 与扁平目录方案；补明失败 turn 的上下文投影、恢复修复事件、`eventId` 用途和目录/权限/删除范围，作为后续规格的推荐决策。

讨论重置：2026-10-26（Asia/Shanghai）。按用户要求清空第 9 章正文，逐步讨论 yucli 的数据结构与选型；数据结构包括实际 JSONL 文件的 header、逐行记录、字段及完整文件示例。其他章节保留参考项目调研与此前的初步判断，其中对 yucli 的取舍均待重新讨论确认。

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

本节从实际文件内容出发，逐项讨论字段和记录的含义；确认后再整理成规格。本轮只展示一个成功的普通问答，工具往返、失败 turn、目录布局和写入可靠性在后续讨论中补充。

#### 为什么选择带类型的记录

JSONL 规定每个物理行是一个独立的 JSON 值。这里建议每行都使用对象，以 UTF-8 编码；记录之间用换行分隔，每条记录末尾包含换行，字符串内容中的换行通过 JSON 的 `\n` 转义保存。整个文件不加外层数组，记录之间也不加逗号。

需要先比较两种数据形态：

| 形态 | 每行保存什么 | 能表达什么 |
| --- | --- | --- |
| 纯消息记录 | `{ "role": "user", "content": "你好" }` 等消息对象 | 能还原消息顺序；会话身份和 turn 是否完成还需要其他结构表达 |
| 带类型的记录（本轮推荐） | 用 `type` 区分会话信息、消息和 turn 终止记录 | 同一文件能表达消息内容与执行边界；恢复时需要按记录类型解释 |

推荐第二种，原因是一次用户提问可能包含多次模型调用和工具往返，也可能中断；持久化需要表达这些消息属于哪次提问，以及执行是否已经结束。采用这种记录形态不要求同时引入事件总线或数据库投影系统。

#### 一个最小完整文件的候选示例

以下四行构成一个可逐行解析的 JSONL 示例；示例 ID 是便于阅读的占位值，实际 ID 的生成规则尚待讨论。示例时间使用 UTC ISO 8601 格式。

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

这里一个 turn 指一次用户提问及其后续执行；一次 turn 可以包含多次模型请求。示例中的两条 message 采用完整消息粒度；流式片段如何拼装、何时 append 和何时 fsync 需要后续分别讨论。

#### header 与后续记录的字段

第一行 header 的候选字段：

| 字段 | 作用 | 本草图的约定 |
| --- | --- | --- |
| `type` | 告诉读取器这是会话头 | 值为 `session_meta`，只出现在第一行 |
| `formatVersion` | 确定整个文件按哪一版格式解释 | 示例为 `1`；本草图放在 header，后续行不重复 |
| `sessionId` | 标识会话，供定位和恢复使用 | 跨进程保持；生成规则待讨论 |
| `createdAt` | 会话创建时间 | 示例用 UTC ISO 8601 字符串 |
| `cwd` | 创建会话时的工作目录 | 示例保存绝对路径；恢复后的目录匹配规则待讨论 |

后续记录的候选公共字段：

| 字段 | 作用 | 本草图的约定 |
| --- | --- | --- |
| `seq` | 确定记录顺序，帮助检查缺失、重复或倒退 | header 后从 `1` 开始递增；校验失败如何处理待讨论 |
| `type` | 说明这行属于哪种记录 | 本轮只展示 `message` 和 `turn_end` |
| `timestamp` | 记录创建时间，便于展示与诊断 | 顺序仍由 `seq` 表达，不能依赖系统时钟排序 |
| `turnId` | 把同一次用户提问的相关记录关联起来 | `turn-1` 的消息和结束记录使用相同值 |
| `payload` | 保存该类型的业务数据 | `message` 保存消息对象，`turn_end` 保存执行结果 |

`type` 和 `payload.role` 分别回答“这是一条什么记录”和“消息是谁发出的”。例如 `type: "message"` 的 payload 可以是 user 或 assistant 消息；`type: "turn_end"` 的 payload 没有消息角色。该分工可以沿用现有 `Message` 的 `role`、`content` 字段，再由存储外层补充顺序、时间和 turn 归属。

#### 读取时怎样使用

读取第一行恢复会话基本信息，再按顺序解释后续记录：`message` 提供消息内容，`turn_end` 提供 turn 完成边界。恢复器据此构造模型所需的 `Message[]`，header 和结束记录各自用于元数据与状态处理。

本轮不预设“文件里出现的每条 message 都进入下次模型请求”。失败、中断或消息组不完整时怎样投影，需在后续讨论中明确。

本轮待讨论：是否采用“会话头 + 带类型的记录”这一外层结构，是否使用 `type: "message"` 包装现有消息，以及上述字段是否都有必要。工具往返的具体 JSONL 候选格式见 9.2；外层字段和工具记录均仍在讨论中。`eventId`、消息 ID、`parentId` 等附加字段需结合各自用途逐项评估。

### 9.2 数据结构讨论（二）：工具调用与结果的持久化

讨论日期：2026-10-26（Asia/Shanghai）。状态：**候选设计，尚未确认**。

本节对照现有类型和实际转换代码，讨论工具往返怎样落在 9.1 的 JSONL 结构中。重点是保存完整调用和已交付的执行结果；取消、崩溃、模型/保存错误的事件字段与落盘时机继续留待后续讨论。

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
| turn 结束 | 沿用 9.1 的 `type: "turn_end"` | 评价整次提问的结果；完整 outcome 和错误字段后续讨论 |

本轮建议不另建重复的 `tool_call` 记录；完整调用已在 `assistant.toolCalls` 中。同一结果只写一条 `tool_result`，不再写一条 `type: "message"` / `role: "tool"` 复制内容，避免恢复时出现双份工具结果。

现有校验只保证**同一 assistant 响应批次内**调用 ID 唯一。不同响应可能重复使用同一 ID，因此建议在工具结果 payload 增加存储层字段 `callMessageSeq`，指向提出调用的 assistant 记录的 `seq`。结果的本地配对键为 `(sessionId, turnId, callMessageSeq, toolCallId)`，不能只用全会话的 `toolCallId → result` 字典。

`callMessageSeq` 不属于现有 ToolResult 或模型请求格式。它在创建持久化记录时补入，恢复为 ToolMessage 时省略；同一批多个结果共享 callMessageSeq，各自使用不同的 toolCallId。

#### 一次完整工具往返的 JSONL 候选示例

以下是完整文件示例。时间只演示记录字段，不代表已经决定 append/fsync 的具体时机。

```jsonl
{"type":"session_meta","formatVersion":1,"sessionId":"session-demo","createdAt":"2026-10-26T02:00:00.000Z","cwd":"/example/project"}
{"seq":1,"type":"message","timestamp":"2026-10-26T02:00:01.000Z","turnId":"turn-1","payload":{"role":"user","content":"总结 README.md"}}
{"seq":2,"type":"message","timestamp":"2026-10-26T02:00:02.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"我先读取文件。","toolCalls":[{"id":"call-1","name":"read_file","argumentsJson":"{\"path\":\"README.md\"}"}]}}
{"seq":3,"type":"tool_result","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-1","name":"read_file","ok":true,"content":"# yucli\n一个终端 Agent 项目。\n"}}
{"seq":4,"type":"message","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"README 介绍了一个终端 Agent 项目。"}}
{"seq":5,"type":"turn_end","timestamp":"2026-10-26T02:00:05.000Z","turnId":"turn-1","payload":{"outcome":"success"}}
```

这里 `seq: 2` 保存模型的调用，`seq: 3` 保存本地执行结果；`callMessageSeq: 2` 和 `toolCallId: "call-1"` 把结果定位到该 assistant 消息中的具体调用。`seq: 4` 是最终回答，`seq: 5` 才表示整个 turn 成功结束。

`argumentsJson` 在磁盘上看起来包含转义引号，是因为外层 JSON 保存了一个 JSON 字符串。读取 JSONL 后，该字段仍是 `{"path":"README.md"}` 的字符串。恢复器可解析它进行结构校验，再保留原字符串重建 assistant 调用；这一步不触发工具执行，也不把字符串直接当对象访问。

如果文件不存在，只需将上述文件中 `seq: 3` 和 `seq: 4` 的事件替换为：

```jsonl
{"seq":3,"type":"tool_result","timestamp":"2026-10-26T02:00:03.000Z","turnId":"turn-1","payload":{"callMessageSeq":2,"toolCallId":"call-1","name":"read_file","ok":false,"content":"[file_not_found] 文件不存在。"}}
{"seq":4,"type":"message","timestamp":"2026-10-26T02:00:04.000Z","turnId":"turn-1","payload":{"role":"assistant","content":"README.md 不存在，暂时无法根据文件内容总结。"}}
```

这是同一示例文件的两行替换片段，header 和其他事件不变。工具结果是 `ok: false`，而模型随后正常解释了原因，因此这个示例仍以 `turn_end` / `outcome: "success"` 结束。整次 turn 执行失败时如何记录，继续在下一轮讨论。

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

一个完整工具往返的结构检查应能确认：引用的是同一 turn 中更早的 assistant 记录；其中存在匹配的 ToolCall.id；工具名一致；每项调用有且仅有一个对应结果；结果按消息和工具执行顺序出现。缺失、重复或中断时的事件字段和恢复处置留待后续设计。

#### 当前代码能提供哪些保存输入

`runTurnStream` 完整成功后同时返回 `appendedMessages` 和 `toolResults`。前者给出 user/assistant/tool 的消息顺序，后者保留含 ok 的执行结果；只保存前者会丢失 ok，只保存后者又缺少用户消息和 assistant 调用。

未来存储转换可以顺序遍历 appendedMessages，遇到 tool 消息时消费下一项 toolResults，检查 ID、工具名和 content 一致，再生成一条 tool_result 并补入对应 assistant 记录的 seq。按批次和顺序配对，不依赖调用 ID 在整个 turn 中唯一。持久化 schema 仍应有独立运行时校验和 formatVersion；代码类型后续变化不能静默改变已写文件的解释。

当前异常出口不交付部分 `StreamTurnResult`，`executeToolBatch` 也不返回半批结果。因此本节尚不能承诺崩溃前每个工具动作都已记录；如果以后需要中途保存，需要另外设计 core 的事件交付与保存时机。本次仅修改调研记录，不改变现有类型或代码行为。

源码依据：[消息类型](../../src/contracts/message.ts)、[工具类型](../../src/contracts/tool.ts)、[结果生成与异常](../../src/core/toolRegistry.ts)、[流式 turn 的两份结果视图](../../src/core/runTurnStream.ts)、[HTTP 消息映射](../../src/adapters/opencode-go/OpenCodeGoClient.ts)。

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
