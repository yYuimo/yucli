# ADR-006：会话使用严格 JSONL 日志和单写者恢复

状态：`accepted`

日期：2026-10-27（Asia/Shanghai）。调研已收口，本记录随阶段 04 规格提交评审；用户已完成评审并接受该设计，T2–T8 的局部实现状态见文末，整个阶段尚未验收。

入口修订：2026-10-28（Asia/Shanghai）。按用户建议参考 Codex CLI/Pi，增加默认 picker、continue 最近会话和 /new 主命令；这些入口已纳入本次 accepted 决策。

## 背景与问题

阶段 03 只在内存保存成功 turn。阶段 04 需要跨进程恢复、保留中断前工具事实，并避免两个进程同时改写同一会话。模型历史与执行日志的用途不同：取消的调用没有普通结果，已产生的结果也不能因后续失败而从日志消失。

## 决定

- 用扁平目录 `~/.yucli/sessions/<timestamp>_<uuid>.jsonl` 保存追加事件，格式版本只在首行 header；独立 tool_result 保留 ok，start/end 表达分派边界，不重复存 tool_call 或 ToolMessage。
- core 通过有序、可等待的业务事实接口交付；文件 seq/引用与同步属于 adapter。只有完整成功 turn 进入模型上下文，只有 turn_end(success) 保存确认后 REPL 提交历史。
- 业务屏障等待完整写入和文件 fsync；新路径同步必要目录。失败后停止追加，不以 eventId 或重试暗示未实现的幂等/恰好执行一次语义。
- 采用 fs-ext@2.1.1 非阻塞内核锁，锁定稳定 sidecar，覆盖整个可写会话。正常不删锁文件；进程消亡由内核释放，不基于心跳或年龄抢占。
- 恢复要求 cwd realpath 相等，持锁重扫；语义损坏拒绝整个文件。只有可证明未完成的尾行或合法缺 LF 记录可在完整备份确认后修复，不补旧 turn_end，不重跑旧工具。
- v1 持久化仅支持已探针验证的 macOS arm64 + Node 24.14.0 + 本地文件系统。REPL 自动保存，普通 --prompt 不保存；/new 换新会话，/clear 保留同义别名；配置来自当前环境，user 外层仅记录 provider/model。
- 无 ID 的 --resume/-r 与 /resume 默认打开同一选择器；--continue/-c 按当前 cwd 有效非空候选选最近，完整 ID 可直达。--all 用于列表或 picker，其他 cwd 仍仅预览。选定后访问失败不自动换旧会话或新建；非 TTY 不进入交互选择。

## 理由与取舍

JSON 消息数组不能完整表达工具分派、取消和 turn 提交，整文件覆盖也扩大崩溃风险；JSONL 便于逐条验证和学习。SQLite、查询索引、树分支与压缩有实际价值，但当前场景不需要其工程规模，后续增加时须显式迁移。

逐屏障 fsync 比后台接受或普通 flush 更慢，但给执行和提交提供清楚的确认点。工具执行与日志同步无法构成原子事务，仍有结果未知窗口；本方案不承诺 exactly-once 或所有设备断电绝对不丢失。

mkdir 占位锁无需原生依赖，但崩溃后自动接管与清理竞态未解决；心跳可能误判暂停进程。内核锁引入编译和平台限制，依赖不可用时明确失败，不能静默换用较弱语义。fs-ext 精确版本以 optionalDependencies 安装并按需加载，允许不支持原生构建的环境继续安装无持久化模式；持久化写入仍必须成功加载并通过预检。安装/行为探针只验证依赖，不代表应用已经实现。

严格拒绝语义损坏牺牲了部分“尽量恢复”，但避免跳过坏记录后伪造健康历史。完整备份比只保留尾部更占磁盘，并含敏感原文；权限限制不能代替加密，v1 无自动清理。无索引、分页和记录字节硬上限是明确限制，不能把流式扫描称为单行内存有界。

恢复入口借鉴 Codex CLI 的默认 picker / --last / ID 分流，以及 Pi 的 --continue/-c、--resume/-r 和 current/all 选择。yucli 采用行式编号、范围切换、刷新和取消，帮助用户直接选择而不必记 ID；完整 TUI、Tab/Esc、名称匹配及 transcript 预览延期。--continue 不跳过忙碌的最近候选，以免悄悄改变上下文；cwd 恢复边界不因全局视图而放宽。

## 影响

- 新增业务事实、存储/恢复接口和稳定错误，重构逐项工具交付、结果取消检查及 REPL 历史提交；core 保持无平台依赖，adapter 不反向依赖 core。
- 新增原生锁、同步、扫描前缀分类、备份修复及退出监督；具体 30 秒操作期限/5 秒故障收尾以规格为准。
- CLI/REPL 的默认保存、resume/continue/list/new/clear 和错误退出发生可观察变化，必须同步契约、架构、帮助及测试；新增共享 picker 和输入/取消所有权，存储接口不感知交互；普通单次模式保持无会话副作用。
- 尚无生产会话数据需要迁移；正式发布 v1 后的格式变化必须有明确版本与兼容策略。

## 关联阶段、契约和代码

- [阶段 04 规格](../specs/phase-04-session-persistence.md)
- [会话持久化调研报告](../research/session-persistence-research.md)
- [现有 REPL 契约](../contracts/repl.md)、[工具执行契约](../contracts/tool-execution.md)、[CLI 契约](../contracts/cli.md)：阶段 04 扩展已同步 T8 子集，完整阶段验收仍待 T9/T10。
- [会话存储契约](../contracts/session-store.md)已固定阶段 04 的跨层边界，状态为 `draft`，待实现和运行时验证后接受。
- T2–T5 已实现 contracts/session 业务数据/稳定错误/writer 能力，以及 adapters/session 的锁、扫描、新文件/writer 和存储恢复/修复；T5 通过目标测试，并获用户授权独立提交。T5 沿用本决策，修改后失败保留实际字节与备份，不增加回滚、自动重放或新锁算法。
- T6 新增可等待事实 sink、逐项执行屏障、ToolExecutionError 和实时/恢复共用纯模型投影；合法工具输出先保留为 ToolResult，再检查取消。恢复仅消费 T5 的 success 业务组，返回最后 20 组消息，不重建执行、不让 adapter 依赖 core。新增 57 项测试，目标环境 17 文件/749 项及 typecheck/lint/build 全部通过，并获用户授权独立提交。T6 交付时尚未接入协调与产品入口；T7/T8 现已补齐，T2–T8 子集验证仍不等于整个阶段验收。
- T7 实现唯一 user/turn_end 协调和提交凭证，固定安全错误与 outcome 后等待终止保存；30 秒公开等待和真实资源 settle 分开，底层调用未结束不关闭/解锁，超时后不继续写入。bootstrap 的可注入监督保留首次故障、固定 5 秒总期限并提供应急退出调用；T8 已补实际 CLI/REPL 接线，真实故障退出进程验证继续归 T9。目标环境新增 79 项，20 文件/828 项及 typecheck/lint/build 通过，未提交待审查；沿用原决策，没有新增重试、工具期限或存储格式。

- T8 已实现 SessionStore/list、CLI 互斥与配置顺序、共享行式 picker、持久化 REPL 和生产组合根监督接线。list 复用扫描/probe、只读无索引；人工选择无期限，底层 I/O 仍受 30 秒与真实收尾约束。只有成功凭证提交模型历史；恢复不重放工具/请求。
- 本轮按用户确认收口 picker 访问拒绝：释放候选后保留原编号→ID 快照，**仅 a/r** 再 list/重建编号；启动/REPL picker 可重选，REPL 保留旧会话/历史。直接 ID/continue 失败为 5，不回退、不新建；PersistenceError、lock_unavailable、platform_unsupported 不留在 picker 重试。此为既有“编号快照”和拒绝策略的明确化，不改存储格式或锁算法。
- T8 目标环境新增 4 测试文件/172 项，全套 24 文件/1000 项及 typecheck/lint/build 通过，T7/T8 未提交待审查。T9 完整阶段矩阵、真实强制退出/重启恢复及人工 TTY 验收、T10 完成审查均未完成；整体阶段保持 implementing，ADR 的 accepted 设计状态不等于运行时阶段已验收。
