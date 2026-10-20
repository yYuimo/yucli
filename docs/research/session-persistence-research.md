# 阶段 04：会话持久化调研报告

状态：`research-draft`

调研日期：2026-10-20（Asia/Shanghai）

本报告只用于技术选型评审。本次没有修改 `src/`、没有创建阶段规格、接口契约或 ADR，也没有开始阶段 04 实现。

## 1. 调研范围和资料状态

本次围绕四个问题阅读参考项目：

1. 会话和消息以什么形式保存。
2. 一次用户输入、模型输出和工具调用在什么时机写入。
3. 新进程如何 resume，以及崩溃或半截 turn 如何处理。
4. 历史变长后如何做 compaction，同时保持恢复能力。

参考项目：

| 项目 | 本地位置 | 资料状态 |
| --- | --- | --- |
| Pi | `agent-lab/references/pi` | 工作区可读；重点阅读 coding-agent 的 JSONL session、SessionManager 和 compaction |
| ZCode | `agent-lab/references/zcode` | 工作区可读；重点阅读 session-persistence 设计、SQLite store、message/part 和 history hydration |
| DSH | `agent-lab/references/dsh` | 工作区可读；重点阅读 session-format、persistence catalog、版本迁移和 storage contract |
| OpenAI Codex CLI | `agent-lab/references/codex` | 工作区可读；重点阅读 Rust rollout recorder、resume、压缩、索引和状态数据库 |
| OpenCode | `agent-lab/references/opencode` | 源码可读；本地 Git 引用损坏，不能可靠取得 commit hash，因此以下结论以当前源码快照为依据 |

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

### 9.1 推荐的第一版持久化形态

推荐采用**每个会话一个 append-only JSONL 文件**：

```text
<session-directory>/<session-id>.jsonl
```

每行使用小型 envelope，至少包含：

```text
formatVersion
seq
timestamp
eventType
eventId
payload
```

第一版只需要能表达：

- session 创建和基础元数据。
- user prompt。
- assistant 文本和工具调用。
- tool result，包括成功、失败和中断。
- turn 完成、失败或取消。
- 未来 compaction 的 checkpoint 边界。

这里的字段是调研建议，不是已经确定的阶段契约。具体 schema 应等用户评审后再进入阶段规格。

### 9.2 推荐的保存边界

参考 Pi 的“用户输入先落盘”和 ZCode 的“半截 assistant/tool 可识别”原则：

1. 接受 prompt 后，先写入 user 事件，再发起模型请求。
2. assistant/tool 的逻辑状态变化按可恢复边界写入；不要求每个 token 都落盘。
3. 一个 turn 完整成功、失败、取消或被中断时，写入明确的终止事件。
4. 进程关闭前 flush；写入失败不能静默把内存历史当成已保存。

阶段 04 不需要复制 Codex 的压缩后台 worker，但应至少有一个单写者和明确的 flush 语义，避免 REPL 多轮写入互相交错。

### 9.3 推荐的 resume 语义

启动时按 `seq` 读取 JSONL，重建内存 session history：

- 完整 turn 恢复为可继续的 user/assistant/tool 历史。
- 没有终止事件的 turn 标记为 `interrupted`，不自动重跑模型或工具。
- 未完成的工具调用恢复为安全的“上一进程中断”结果，等待用户下一次输入决定是否重新执行。
- 坏的尾部行可以报告并停止在最后一个完整事件；不能悄悄把中间历史拼成成功 turn。
- 原始事件保留，模型上下文由 replay 函数从事件投影得到。

这里借鉴了 Codex、ZCode 和 OpenCode 的共同原则：**恢复历史和恢复运行状态是两件事。** 第一版只恢复历史，不恢复旧进程的网络请求、readline、AbortController 或工具进程。

### 9.4 推荐的 compaction 起点

阶段 04 不必实现自动 compaction，但持久化格式应保留未来空间：

- 原始事件不删除。
- compaction 作为一个带 summary 和保留边界的事件。
- replay 遇到最新可用 checkpoint 时，从 checkpoint + suffix 生成模型上下文。
- 工具调用及其结果必须成对保留；大型结果未来可以替换为明确的截断标记或 artifact 引用。
- 如果 checkpoint 不完整或不可解析，退回更早的可用边界或 full replay，不能让整个会话不可读取。

Pi 的 `firstKeptEntryId`、Codex 的 replacement history/window、ZCode 的 compaction part 和 OpenCode 的 summary/native boundary 都支持这个方向，但它们的字段不能直接混用。

### 9.5 为什么暂不选 SQLite

当前 yucli 仍是单进程、单工作目录、低并发的学习 CLI。此时 SQLite 的主要成本不是 SQL 本身，而是：

- schema migration 和旧数据兼容。
- session/message/part 的事务边界。
- 列表索引、归档、删除、分页和并发锁。
- event/projector 或 message hydrator 的一致性。
- 运行态与持久化状态的恢复规则。

这些问题在 ZCode/OpenCode 中确实有价值，但会把阶段 04 的重点从“理解会话持久化”转成“实现一个小型数据库驱动运行时”。JSONL 足够支撑第一版 resume，也更容易用 `jq`、编辑器和测试夹具观察。

### 9.6 什么时候重新评估 SQLite

出现下面任一需求时，应重新做一次选型，而不是继续扩展 JSONL：

- 需要按标题、目录、更新时间或标签搜索大量 session。
- 多个进程或客户端同时读写一个 session。
- 需要稳定分页、归档、删除、fork、分享和统计查询。
- 工具/part 更新频繁，单个 JSONL 文件重放已经成为瓶颈。
- 需要 durable inbox、execution claim、后台任务或事件投影。

到那时可以参考 ZCode/OpenCode 的 session/message/part 分层，并考虑从 JSONL 做一次显式导入，而不是让两种格式长期同时作为写入真相源。

## 10. 本阶段建议的评审问题

这份调研报告供用户确认方向，下一步只需要评审以下选择，不应直接进入代码：

1. 是否接受“每会话一个 append-only JSONL，SQLite 延后”的总体方向？
2. 是否接受 user prompt 在网络请求前先保存？
3. 未完成 turn 是标记为 interrupted 并等待用户继续，还是允许显式 resume 时重试？
4. 第一版是否只恢复消息历史，不恢复旧工具进程、网络请求和 REPL 状态？
5. 是否先设计一个带 `formatVersion`、`seq`、`eventType` 的小 envelope，再决定完整事件字段？
6. compaction 是否只做格式预留，留到后续阶段实现？

在这些问题确认前，不建议编写阶段 04 规格或实现代码。

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
