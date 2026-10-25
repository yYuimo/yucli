# 阶段 04：会话持久化调研报告

状态：`research-draft`

调研日期：2026-10-20（Asia/Shanghai）

补充日期：2026-10-20（Asia/Shanghai）

变更记录：补正参考快照 commit；补充单写者、落盘成功语义、v1 事件/replay、目录恢复、版本/未知事件、坏行、隐私保留和失败 turn 边界；扩充评审问题。

评审修订：2026-10-25（Asia/Shanghai）。统一文件 header 与扁平目录方案；补明失败 turn 的上下文投影、恢复修复事件、`eventId` 用途和目录/权限/删除范围，作为后续规格的推荐决策。

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

### 9.1 推荐的第一版持久化形态

推荐采用**每个会话一个 append-only JSONL 文件**：

```text
~/.yucli/sessions/<timestamp>_<id>.jsonl
```

`sessions/` 是扁平目录，具体布局见 9.10。第一行是 `session_meta` header，保存 `formatVersion: 1`、会话 ID、cwd 和创建时间；`formatVersion` 只在 header 出现，不在后续事件中重复。后续每行使用小型 envelope，公共字段为：

```text
seq
eventType
eventId
payload
```

需要逐事件时间时，放在对应 payload 中，不额外规定每行都带公共 `timestamp`。`eventId` 在 v1 仅用于诊断和关联记录，不承诺去重或写入重试幂等；见 9.11。

第一版只需要能表达：

- session 创建和基础元数据。
- user prompt。
- assistant 文本和工具调用。
- 成功 turn 中的 tool result，包括工具成功和可恢复的工具错误；不单独记录中途状态。
- turn 完成、失败、取消或超时；缺失终止记录的 turn 在 replay 时标为 interrupted。
- 未来 compaction 的 checkpoint 边界。

这里的字段是调研建议，不是已经确定的阶段契约。具体 schema 应等用户评审后再进入阶段规格。

### 9.2 推荐的保存边界

参考 Pi 的“用户输入先落盘”和 ZCode 的“半截 assistant/tool 可识别”原则：

1. 接受 prompt 后，先写入 user 事件，再发起模型请求。
2. 按 9.14 的完整 turn 边界，在 `runTurnStream` 成功返回后写入 assistant/tool 消息组；不逐 token 或按中间工具状态落盘。
3. 正常运行时，在 turn 成功、失败、取消或超时后写入明确的终止事件；崩溃来不及写终止事件时，由 replay 在内存标记为 interrupted，不在恢复时补写文件。
4. 进程关闭前 flush；写入失败不能静默把内存历史当成已保存。

阶段 04 不需要复制 Codex 的压缩后台 worker，但应至少有一个单写者和明确的 flush 语义，避免 REPL 多轮写入互相交错。

### 9.3 推荐的 resume 语义

启动时按 `seq` 读取 JSONL，重建内存 session history：

- 只有消息组完整且具有 `turn_end(success)` 的 turn 恢复为模型可见的 user/assistant/tool 历史。
- 已失败、取消或超时的 turn 保留原 outcome；没有终止事件的 turn 在内存标记为 `interrupted`，不自动重跑模型或工具。
- 上述非成功 turn 的 user 和任何未提交的 assistant/tool 前缀仅用于记录与展示，不进入下一次模型请求；不合成 tool message 填入模型历史。
- 恢复本身不追加 `turn_end(interrupted)` 修复事件；同一有效前缀重复 replay 得到相同投影，不因多次恢复重复写入记录。后续新 user 使用新的 `turnId`，不会被当成旧 turn 的继续执行。
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

### 9.7 单写者与并发边界

阶段 04 的 v1 推荐只支持**同一会话同一时间一个写者**。这里的“写者”是负责该 session 文件 append、flush 和 replay 快照的一条进程内写入路径；不承诺两个线程、两个 REPL 实例或两个进程同时修改同一文件。

多进程同时追加 JSONL 可能造成：

- 两个写者分配出重复或交错的 `seq`。
- 一行 JSON 被交错写入，形成无法解析的中部坏行。
- 一个进程按旧历史追加，另一个进程已经写入 turn_end 或 compaction，导致语义顺序错误。
- 一个进程重写/压缩文件时，另一个进程仍持有旧文件描述符，产生丢失或覆盖。

Codex 用进程内 writer task、`WriterLockCoordinator` 和临时文件/原子发布来处理这类边界；这些是本次需要理解的可靠性方案，**阶段 04 暂不实现跨进程锁、压缩转换或原子重写**。如果未来开放多进程 resume，应先新增锁和冲突策略，不能只把 append 调用暴露出去。

### 9.8 “保存成功”的语义与失败行为

`append` 和 `fsync` 不是同一个承诺：

- `append` 表示数据已经交给操作系统文件缓存，进程继续运行时通常可以读到。
- `fsync` 返回成功后，才可以把数据视为已经请求底层文件系统持久化；它仍不等同于跨设备备份。

v1 有两个可评审选项：

| 选项 | 语义 | 优点 | 代价 |
| --- | --- | --- | --- |
| A（推荐） | user 事件发出后先 flush/fsync 一次；turn 终止事件再 fsync 一次 | 崩溃时至少保住用户输入；成功/失败边界也可恢复 | 每个 turn 至少两次 fsync，速度较慢 |
| B | 只在 turn 结束时 flush/fsync | 实现简单、写入次数少 | 模型请求中进程崩溃时，user 事件也可能丢失；不适合承诺“输入已保存” |

推荐 A，因为阶段 04 的核心目标是 resume，用户已经提交的 prompt 不应因为模型尚未返回就消失。按 A 承诺时，进程崩溃最多丢失上一次 fsync 之后的中间事件；若 user 已完成第一次 fsync，则不会丢失该 user，未完成的 assistant/tool 仍由 `turn_end` 缺失表示。

写入失败时的 REPL 行为也有两个方向：

- **推荐**：报告保存错误，把当前内存状态标记为“未保存”，停止接受下一次模型 turn；允许用户重试 flush 或退出。这样不会继续制造已经无法恢复的内存历史。
- **备选**：保留内存历史并继续 REPL，但每次后续输入都带未保存警告。这更顺滑，却容易让用户误以为会话可恢复。

“已保存”的文案只能在所选 fsync 边界成功后出现；append 成功不能单独作为持久化成功提示。

### 9.9 v1 最小事件表与 replay 规则

下面是调研阶段建议的最小事件集合。它不是已经接受的契约；字段和命名需要用户评审后才进入阶段规格。

| 事件 | 是否进入模型历史 | 元数据字段 | 与当前 `Message` 类型的关系 |
| --- | --- | --- | --- |
| `session_meta` | 否 | cwd、模型默认值、创建时间、格式信息 | 不对应 `Message`；用于恢复会话身份 |
| `user` | 仅属于完整成功 turn 时 | `turnId`、来源、创建时间 | 投影为当前 `TextMessage` 的 `{ role: "user", content }`；非成功 turn 中只保留作记录 |
| `assistant` | 仅属于完整成功 turn 时 | `turnId`、finish reason、usage；可带 `toolCalls` | 投影为当前 `AssistantMessage`；阶段 03 已支持 `content?` 和 `toolCalls?` |
| `tool_result` | 仅属于完整成功 turn 时 | `turnId`、`ok`、执行耗时、错误分类 | 投影为当前 `ToolMessage`；`ok` 是本地元数据，`content` 才是模型可见文本 |
| `turn_end` | 否 | `turnId`、outcome、错误、取消原因、保存边界 | 不对应 `Message`；决定本 turn 是否提交到模型历史 |
| `compaction`（预留） | 完成后以 checkpoint 形式影响模型历史 | summary、保留边界、版本和来源 | 未来转换为 summary/checkpoint，不直接伪造普通 user/assistant 消息 |

v1 推荐把工具调用放在 `assistant.toolCalls` 中，不另建 `tool_call` 事件；这样和当前 [Message 类型](/Users/yuimo/dev-learn/agent-lab/yucli/src/contracts/message.ts) 以及阶段 03 的 `runTurnStream` 结果一致。未来如果需要记录流式工具调用的中间状态，再单独增加事件类型。

replay 的建议顺序是：

1. 先读取并校验 `session_meta` header，再按 `seq` 验证后续事件。
2. `session_meta` 只恢复会话元数据。
3. 按 `turnId` 将 `user`、`assistant`、`tool_result` 收集成暂存消息组，不边读边提交到模型历史。
4. assistant 的 tool calls 保留调用 ID、名称和参数；tool result 按 `toolCallId` 关联并检查完整性。
5. 只有遇到 `turn_end(success)` 且消息组完整时，才把该 turn 的 user/assistant/tool 一并提交到模型历史。成功写入时使用已保存的 user，不把 `appendedMessages` 中的首条 user 重复落盘。
6. `turn_end` 不进入消息数组；非成功 outcome 保留原分类，缺少终止事件的 turn 在内存标为 interrupted。新 `turnId` 开始或读到文件末尾，都不会使旧的未提交 turn 自动成功。
7. 遇到已确认的 compaction checkpoint 时，未来由 context builder 用 checkpoint + suffix 替换更早历史。

如果崩溃发生在成功消息组写入中途，文件可能留有 assistant 工具调用而没有对应的 `tool_result` 或 `turn_end(success)`。该 turn 整组排除出模型上下文，仅保留中断诊断，不合成模型可见的工具结果、不自动重新执行工具。若文件已有 `turn_end(success)` 却缺少对应工具结果，则属于语义损坏，应拒绝恢复，不能降级成正常成功 turn。

### 9.10 目录布局与恢复入口

可选布局有三种：

| 方案 | 做法 | 优点 | 风险 |
| --- | --- | --- | --- |
| Pi 风格 cwd 编码目录 | `sessions/--<cwd>--/<timestamp>_<id>.jsonl` | 列表时天然按 cwd 分组 | 长路径、特殊字符、大小写和不同平台路径规则容易产生碰撞或过长路径 |
| 扁平目录 + header 扫描（推荐） | `~/.yucli/sessions/<timestamp>_<id>.jsonl`，cwd 保存在 `session_meta` | 文件名只含安全字符；跨平台规则简单；不会把 cwd 直接放进路径 | 列表需要扫描文件并读取 header，文件多时需要索引 |
| 按 hash 分组 | `sessions/<cwd-hash>/<timestamp>_<id>.jsonl`，header 保留原 cwd | 路径短，分组扫描成本较低 | 需要维护 hash 算法、碰撞处理和跨版本稳定性 |

推荐扁平目录：session ID 使用 UUID/安全字符，时间仅用于排序，真实 cwd 只写入 header。这样不需要把 `/`、`\\`、`:`、空格、Unicode、大小写路径规则编码进文件名；Windows 大小写不敏感、macOS 规范化和 Linux 大小写敏感的差异也不会改变文件定位。

默认根目录推荐固定为当前用户的 `~/.yucli/sessions/`，不在项目内创建 `.yucli/`；v1 不提供项目内存储切换。不同 cwd 的会话共享这个扁平目录，靠 header 过滤；目录和文件权限见 9.13。

长路径和特殊字符仍需要在 header/filter 层处理：cwd 应保存规范化后的绝对路径，但“是否大小写折叠”属于跨平台待确认规则，不能在报告阶段假定所有系统一致。

恢复入口暂列为开放项：

- 会话列表：扫描 header，显示 ID、创建/更新时间、cwd 和首条 user 文本。
- cwd 过滤：按规范化路径匹配，大小写策略待确认。
- `--continue`：推荐先恢复当前 cwd 最近一个 session。
- `/resume`：后续提供交互选择器；也可以先支持 `--resume <session-id>`。
- 显式路径恢复：可作为调试入口，但不应成为普通用户的唯一方式。

### 9.11 版本与未知事件

推荐把 `formatVersion` 放在**文件 header**，而不是每一行重复：

- 一个文件只需读取一次格式版本。
- 后续每个事件行保留 `seq`、`eventType`、`eventId` 和 `payload`，避免重复版本字段；需记录的事件时间放入 payload，与 9.1 一致。
- header 缺失或损坏时不能可靠判断整段文件的解释方式，应拒绝恢复并报告。

同一版本遇到未知 `eventType` 时，推荐采用显式可忽略标记：

- `ignorable: true` 的未知事件可以跳过，但要记录警告并继续检查 `seq`。
- 没有可忽略标记的未知事件拒绝恢复，因为它可能改变模型历史或 turn 终止语义。

遇到高于当前支持版本的 `formatVersion`，拒绝恢复并提示升级；低于当前版本时，只有存在明确的相邻迁移才能读取。这里采用 DSH 的“相邻迁移”原则，但 v1 暂不实现完整迁移目录；未来版本增加时不能静默重解释旧 payload。

`eventId` 推荐在 v1 **仅用于诊断和关联记录**，不作为 replay 去重键，不承诺写入重试幂等。事件顺序和连续性由 `seq` 校验；遇到重复或不连续的 `seq` 按 9.12 拒绝恢复，不能靠相同 `eventId` 静默跳行。9.8 的保存失败恢复策略也不能假定“重新 append 同一 eventId 就不会重复”；是否重试以及如何确认已写入前缀，需要在存储规格中明确。

### 9.12 坏行位置策略

坏行需要区分位置：

- **尾部坏行**：如果坏行是文件最后一行，且前面的最后一行以换行结束，可以把它视为进程崩溃留下的半截写入；停止在最后一个完整事件，报告“尾部未完成”，并允许恢复已确认的前缀。
- **中部坏行**：如果坏行后面还有有效事件，不能确定 `seq`、turn 或工具结果是否被跳过；v1 应拒绝整段恢复，避免把不连续历史拼成合法上下文。

每行的 `seq` 用于检测：

- 重复：同一 session 内出现相同 `seq`，拒绝恢复。
- 缺口：`seq` 不连续，拒绝恢复；除非未来事件格式明确允许范围/继承边界。
- 倒退：`seq` 小于前一行，拒绝恢复。

Codex 的 `load_rollout_items` 会统计 `parse_errors` 并跳过坏 JSON 行，这是它在复杂 rollout、兼容旧数据和索引回填中的取舍。yucli 的模型历史更小但语义更敏感，v1 不建议直接复制“中部坏行继续读”的策略；可以保留 Codex 的诊断计数思路，用于显示恢复警告。

### 9.13 隐私与保留

会话文件会包含用户原始输入、assistant 回答、工具调用参数，以及 `read_file` 读到的文件内容。它可能包含源码、配置片段、路径、个人信息或密钥误输入。因此：

- v1 明文保存，不加密；报告必须明确这是本地学习项目的选择，不是安全存储保证。
- 不把 API key、Authorization 头或完整 HTTP 原始响应写入会话。
- 默认目录推荐 `~/.yucli/sessions/`，不使用项目内 `.yucli/`，降低把会话内容误提交到项目仓库的机会。
- 在 POSIX 系统，新建 `~/.yucli/` 和 `sessions/` 目录时使用 `0700`，新建会话文件使用 `0600`。这些是创建权限要求，不代表既有路径权限会自动收紧，也不保证其他平台等效；既有路径检查、符号链接处理和 Windows ACL 支持边界需在规格中明确。
- v1 不主动备份、上传或同步会话文件；用户自行配置的主目录备份和同步不受 yucli 控制。
- 推荐 v1 暂不提供删除命令，也不做按会话数、总容量或时间过期的自动清理。需要删除时，用户先退出使用该会话的进程，再手动删除对应 JSONL；正式删除命令和保留策略留到后续阶段。
- 导出/分享不属于阶段 04 初始范围；在实现前必须重新评估敏感内容暴露。

### 9.14 失败/取消 turn 的持久化

阶段 03 的 `runTurnStream` 只有在完整成功时才返回 `StreamTurnResult.appendedMessages`；流中途失败、取消或超时不会把半截消息提交给 REPL 内存历史。阶段 04 若要保持这个行为，应采用以下推荐边界：

1. user 事件在发起模型请求前持久化；因此恢复时用户输入存在，即使模型没有回答。
2. assistant 和 tool_result 只在整个 turn 成功、拿到 `appendedMessages` 后作为一组写入。
3. 半截 assistant 文本、未完成的流式 tool call 和屏幕上已经显示的 delta 不写成模型历史消息。
4. 正常运行时，无论成功、失败、取消还是超时，都写 `turn_end`；失败时记录 outcome、错误分类和取消原因。成功 turn 的持久化提交点是完整消息组和 `turn_end(success)` 一起完成 9.8 的 fsync 边界；在此之前不向 REPL 提交为已保存的历史。
5. 恢复时保留已有 `turn_end` 的失败、取消或超时分类；没有终止事件时，仅在内存标记为 interrupted。v1 不自动追加 `turn_end(interrupted)` 修复事件，也不自动重跑模型或工具；同一有效日志前缀重复恢复产生相同结果，不靠 `eventId` 去重。
6. **失败、取消、超时或 interrupted turn 的 user 不进入后续模型上下文**，只保留在持久化记录和可展示的历史中；若写入消息组后崩溃且没有成功终止事件，连同该组 assistant/tool 一起排除。当前进程继续和新进程恢复都使用此规则，避免模型把未回答的旧问题和新输入一起回答。用户需要重试时，显式重新提交 prompt，创建新的 `turnId`。

这种策略与阶段 03 对齐，但有一个明确限制：如果某一批工具已经执行成功、随后最终模型请求失败，阶段 04 v1 只保留 user + turn_end，不保留那批未形成 `appendedMessages` 的工具往返。若未来要完整审计半截工具状态，需要先修改 core 的交付契约，再单独设计事件和幂等执行规则。

以上投影规则区分“日志中有这条 user”和“模型要再次看到这条 user”。正常失败时 user + turn_end 可供后续展示；崩溃或保存失败时可能只有 user 或未提交的消息前缀，均不能凭“已经写入文件”就进入模型历史。恢复标记只在内存产生，文件保留原始事实；坏尾行后如何安全继续追加仍须按 9.12 在规格中定义，不把只读 replay 当成文件已修复。

## 10. 本阶段建议的评审问题

这份调研报告供用户确认方向，下一步只需要评审以下选择，不应直接进入代码：

1. 是否接受“每会话一个 append-only JSONL，SQLite 延后”的总体方向？
2. 是否接受 user prompt 在网络请求前先保存？
3. 是否采用 9.14：非成功 turn 的 user 仅保留作记录与展示，不进入后续模型上下文；恢复只在内存标记 interrupted，不补写修复事件，重试必须作为新 turn 显式提交？
4. 第一版是否只恢复消息历史，不恢复旧工具进程、网络请求和 REPL 状态？
5. 是否采用 9.1/9.11：`formatVersion` 仅放在 `session_meta` header，事件行使用 `seq`、`eventType`、`eventId`、`payload`；v1 的 `eventId` 仅用于诊断，不提供去重或重试幂等？
6. compaction 是否只做格式预留，留到后续阶段实现？
7. 是否采用默认 `~/.yucli/sessions/<timestamp>_<id>.jsonl` 的扁平目录和 header cwd 过滤？会话列表与 `/resume` / `--continue` 的首版范围仍需在规格中明确。
8. 阶段 04 是否明确只支持单进程、同一会话单写者？
9. 写入失败、append/fsync 语义和 REPL 行为采用哪种方案？
10. 是否采用 9.13：POSIX 新目录 `0700`、新文件 `0600`，v1 无删除命令、自动清理或主动备份/上传？既有路径权限与跨平台支持边界需在规格中明确。

本轮修订仍只更新调研报告。后续阶段 04 规格应把以上推荐方向写成明确的范围、契约和验收条件；规格确认前不开始实现代码。

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
