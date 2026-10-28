# ADR-006：会话使用严格 JSONL 日志和单写者恢复

状态：`proposed`

日期：2026-10-27（Asia/Shanghai）。调研已收口，本记录随阶段 04 规格提交评审，尚未实现。

入口修订：2026-10-28（Asia/Shanghai）。按用户建议参考 Codex CLI/Pi，增加默认 picker、continue 最近会话和 /new 主命令，保持 proposed。

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
- [现有 REPL 契约](../contracts/repl.md)、[工具执行契约](../contracts/tool-execution.md)、[CLI 契约](../contracts/cli.md)：阶段 04 扩展待实现同步。
- 计划新增 session-store 契约及 contracts/session、core 协调/投影和 adapters/session；尚未创建生产实现。
