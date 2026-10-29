# 会话存储契约

状态：`draft`

适用阶段：阶段 04 会话保存与恢复。本文固定设计边界；实现和第 04 阶段验收矩阵通过后，才将状态改为 `accepted`。

## 目的和边界

会话存储负责把一次 REPL 的业务事实追加到本地 JSONL 文件，并在重新启动时扫描、校验和投影为可继续的模型历史。它不调用模型、不执行工具、不读取 `.env`，也不决定 REPL 的交互方式。`bootstrap` 组装存储根、规范化 cwd、时钟、UUID 和锁适配器；`core` 只通过本契约交付有序事实。

阶段 04 的持久化创建和恢复只支持 macOS arm64、Node 24.14.0 和本地文件系统。普通 `--prompt`、帮助、版本和只读列表不创建会话，也不因为持久化依赖不可用而提前失败。

## 参与方与所有权

| 参与方 | 责任 | 不负责的内容 |
| --- | --- | --- |
| `core/runPersistentTurn` | 生成 user、assistant、工具事实和唯一 `turn_end`；等待每次保存确认；成功后交付提交凭证 | 文件路径、seq、锁、JSONL 和 `process.exit` |
| `TurnFactSink` | 将 core 的工具事实按顺序转交给 writer，并等待确认 | fire-and-forget 事件广播、原始 Error 或取消 signal |
| `SessionWriter` | 校验本地引用，分配 seq，追加 JSONL，执行同步屏障并维护故障状态 | 调用模型、执行工具、重试不确定写入 |
| `SessionStore` | 创建/打开会话、列出只读摘要、登记资源、统一关闭 | 选择 picker 编号、提交 REPL 历史 |
| `bootstrap/repl` | 持有最近 20 个成功 turn，接入新建/恢复/切换和退出 | 直接拼装 JSONL 或绕过 writer 写文件 |

一个进程只能为同一 sessionId 持有一个可写 writer。writer 从取得锁开始一直持有资源到正文关闭和解锁；等待用户输入期间也不能释放锁。`SessionStore.close()` 是幂等的进程级收尾：首次调用拒绝新操作，等待已发出的 I/O settle，关闭所有 writer，再释放锁。

## JSONL v1 格式

会话文件是 UTF-8、每行一个 JSON 对象、每行以 LF 结束的扁平日志，没有数组外壳。第一行必须是唯一 header：

```json
{"type":"session_meta","formatVersion":1,"sessionId":"s-123","createdAt":"2026-10-29T12:00:00.000Z","cwd":"/repo"}
```

header 字段约束如下：

| 字段 | 约束 |
| --- | --- |
| `type` | 固定为 `session_meta` |
| `formatVersion` | 固定整数 `1`；其他版本为 `unsupported` |
| `sessionId` | 非空且与受管文件身份一致；新建使用 UUID v4 |
| `createdAt` | UTC ISO 8601；文件名时间与本值来自同一次取值 |
| `cwd` | 创建时 cwd 的 realpath 绝对路径 |

header 后每条记录都包含 `seq`、`type`、`timestamp`、`turnId` 和 `payload`。`seq` 从 1 开始连续递增，`timestamp` 是 UTC ISO 8601 展示时间，不决定顺序；新 turnId 不得复用旧值。v1 不保存 eventId、parentId、磁盘 assistantId 或幂等重试字段。

允许的记录类型：

| `type` | `payload` | 作用 |
| --- | --- | --- |
| `message` + `role:user` | `{role:"user",content:string}` | 一个 turn 的唯一起点；外层另有 `runtimeProfile` |
| `message` + `role:assistant` | 完整 `AssistantMessage` | 保留文本和工具调用；最终无调用回答不得为空白 |
| `tool_start` | `{callMessageSeq,toolCallId,name}` | 表示准备分派，不保证已进入工具实现 |
| `tool_result` | `{callMessageSeq,toolCallId,name,ok,content}` | 已取得的正常 `ToolResult`；`ok:false` 仍是合法结果 |
| `tool_end` | `{callMessageSeq,toolCallId,name,outcome,error}` | 没有正常结果的异常终止 |
| `turn_end` | `{outcome,error?}` | 唯一的 turn 终止事实，决定历史提交资格 |

`user` 记录外层的 `runtimeProfile` 只包含非空的 `provider` 和 `model`。不保存 API key、endpoint、环境变量、工具配置或摘要。模型的 `tool` 消息由恢复投影从 `tool_result` 生成，不在日志中重复保存。

`error` 是脱敏对象：

```ts
type SafeError = {
  category: "model" | "tool" | "protocol" | "limit" | "cancellation" | "timeout" | "internal";
  code: string;
  message: string;
  httpStatus?: number;
};
```

不得 stringify 原始 Error、保存堆栈、认证头或未经限制的响应正文。`turn_end` 的 `success` 不带 error；`failed`、`cancelled` 和 `timeout` 必须带匹配分类的 error。

## 跨层接口

以下是实现必须提供的业务边界。TypeScript 类型检查不能替代运行时 JSON、顺序、引用和 cwd 校验。

```ts
type RuntimeProfile = { provider: string; model: string };

type FailureEnd = {
  outcome: "failed" | "cancelled" | "timeout";
  error: SafeError;
};

type TurnEnd = { outcome: "success" } | FailureEnd;

type CallRef = {
  assistantId: string;       // turn 内的临时 a1、a2，不是文件 seq
  toolCallId: string;
  name: string;
};

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

interface SessionWriter {
  appendDurable(fact: TurnFact): Promise<{ confirmedSeq: number }>;
  close(): Promise<void>;
}

interface SessionStore {
  create(cwd: string): Promise<OpenedSession>;
  openWrite(input: { sessionId: string; cwd: string }): Promise<OpenedSession>;
  list(input: { cwd: string; all: boolean }): Promise<SessionList>;
  close(): Promise<void>;
}
```

`SessionWriter.appendDurable()` 返回表示该记录及此前前缀已经完整写入、排空应用缓冲并通过 `FileHandle.sync()` 的确认序号。它不是排队成功、write 回调或普通 flush。新建目录和正文需要同步必要的目录项。

writer 在写入、同步、契约或所有权失败后进入故障状态，拒绝后续 append；不在同一 writer 上重试不确定的写入。接口不接受已取消的 signal，必要的终止保存必须能够完成。保存故障不能包装成普通工具结果，也不能递归写 `tool_end` 或 `turn_end`。

## 恢复投影和列表读模型

扫描器在持锁恢复前和只读列表时都必须按字节边界读取、严格解码 UTF-8，并逐行执行 JSON、schema、seq、引用和生命周期校验。中间坏行、未知事件、非法引用和语义损坏拒绝整个文件，不跳过记录。只允许最后一行可证明为 JSON/UTF-8 前缀残片，或完整合法记录但缺少 LF；修复前必须完成原件备份、清单同步、大小与 SHA-256 复核，修复后重新扫描确认。

恢复只返回已校验的业务数据，不把磁盘 seq 或内部 assistantId 交给 core：

```ts
type RecoveredItem =
  | { type: "user"; message: TextMessage & { role: "user" } }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResult };

type RecoveredTurn = {
  turnId: string;
  runtimeProfile?: RuntimeProfile;
  items: readonly RecoveredItem[];
};

type SessionSnapshot = {
  meta: { sessionId: string; createdAt: string; cwd: string };
  recentSuccessfulTurns: readonly RecoveredTurn[];
  lastUserProfile?: RuntimeProfile;
  interruptedTurnCount: number;
  repair: "none" | "truncate_tail" | "append_lf";
};

type OpenedSession = { writer: SessionWriter; snapshot: SessionSnapshot };
```

只有完整 `turn_end(success)` 的 user、assistant 和正常工具结果进入下一次模型历史；失败、取消或中断 turn 中已经确认的事实保留在日志，但不提交为可继续的成功 turn。恢复不写伪造 `turn_end`，不重跑旧模型请求或工具。

列表是只读内存读模型，不创建目录、不写索引、不取得候选写锁。`list({ cwd, all })` 返回当前 realpath 过滤、排序和诊断信息；`writerState` 与 `logState` 分开计算。列表不能替代正式 `openWrite`，恢复必须重新取独占锁、重扫并在必要时修复。

```ts
type SessionListEntry = {
  sessionId: string;
  cwd: string;
  createdAt: string;
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
```

合法条目按 `lastActivityAt`、`createdAt`、`sessionId` 降序/字典序排序。`--sessions` 输出完整 `sessionId`，供 `--resume <sessionId>` 和脚本使用；共享 picker 只展示编号，不显示或要求复制 ID。默认隐藏 header-only 会话；`--all` 只改变初始列表范围，不放宽 cwd 恢复边界。`preview` 是首条 user 的单行安全摘要，最多 80 个 Unicode 码点，不展示工具原文。

## 文件、锁和生命周期

默认布局为：

```text
~/.yucli/
├── sessions/<timestamp>_<sessionId>.jsonl
├── locks/<sessionId>.lock
└── recovery/<sessionId>/<timestamp>_<uuid>.jsonl.bak
                         <timestamp>_<uuid>.repair.json
```

目录权限为 0700，正文、锁、备份和清单为 0600；不加密、不自动清理。持久化路径使用 `fs-ext@2.1.1` 的非阻塞 advisory flock：可写恢复用独占锁，占用探测用短暂共享锁。依赖不可用时不得静默退回 mkdir、心跳或无锁写入。锁文件正常释放后保留，进程死亡由内核释放。

`create()` 在首次普通输入前完成平台/锁预检，生成新 UUID，独占创建正文并保存 header；随后 coordinator 保存 user，确认成功前不发模型请求。`openWrite()` 只定位受管文件，不使用 `a+` 创建不存在的会话；它在取得锁、完成全文件校验和必要尾部修复后才返回句柄。

每个公开存储操作 `create`、`openWrite`、`list`、`appendDurable`、`close` 的总等待上限为 30 秒。超时是 `PersistenceError(io_timeout)`，不等于业务 request timeout；底层 I/O 未必已取消，adapter 必须继续观察其最终 settle，不得提前解锁或开始后继写入。存储故障触发 bootstrap 的 5 秒总收尾期限，超时仍未清理时由组合根结束进程，退出码为 5。

## T2 锁能力实现状态（2026-10-29）

T2 锁能力已实现，下节 T3 追加 JSONL 类型和只读扫描；本文整体仍为 draft，没有 SessionStore/SessionWriter、备份修复、持久化 CLI 或 core 事实交付。

- [SessionLockAdapter](../../src/adapters/session/SessionLockAdapter.ts) 的 preflight 不创建目录/锁；acquire(sessionId) 以 exnb 返回 SessionLock，assertOwnership 检查路径/描述符 dev/ino 和目录身份，release 等检查完成后关闭描述符，保留稳定锁文件。调用方必须先关闭正文再释放。
- probe(sessionId) 对已有文件以只读 fd + shnb 返回 busy/available/unknown；本进程登记直接 busy，不为自己的锁增加 fd。缺路径/能力不明为 unknown，探测结果不授权写入。根默认 ~/.yucli，可注入隔离根；根的父目录需存在，T2 不代建 home。
- probe(sessionId) 的清理是存储屏障：shnb/所有权检查结束后必须关闭只读 fd；关闭失败不降级为 `unknown`，而是抛 `PersistenceError`（`code: "close_failed"`、`operation: "probe_cleanup"`）。上层列表或恢复将该故障按存储失败收尾，最终退出码为 5；`unknown` 只表示状态/能力无法可靠判断且本次资源清理成功。
- [lockPlatform](../../src/adapters/session/lockPlatform.ts) 精确检查 macOS arm64 + Node 24.14.0，再按需加载 fs-ext，并只读检查本地挂载；失败在创建前抛 platform_unsupported 或 lock_unavailable。没有 mkdir/心跳/无锁降级。
- T2 的锁接口放在 [session-lock.ts](../../src/contracts/session-lock.ts)；T3 将稳定错误统一至 [session.ts](../../src/contracts/session.ts)，旧入口重导出同一个类以保留 instanceof 身份。已有占用为 session_busy，取锁后身份变更为 ownership_lost，任一锁描述符（包括 probe 的只读 fd）关闭失败为 close_failed。
- local 检查使用 macOS mount 的显式 local 标记、最近已存在祖先和最长路径段匹配；未知/非 local 拒绝，不声称识别所有共享挂载或隔离并发父目录替换。只验证本机 APFS，不承诺其他环境。
- T2 不提供 create/openWrite/list/appendDurable/close 的 30 秒期限与 5 秒故障退出；这些依然是完整 SessionStore/writer/T7 的待实现要求。锁适配器不会在 native 调用未 settle 时提前关闭或解锁。

安装工具链、原生构建授权和 D01–D03/D06 子集的实际验证见[阶段 04 的 T2 实际结果](../specs/phase-04-session-persistence.md#t2-依赖与锁实际结果2026-10-29)。锁测试全部在临时目录，未访问真实 ~/.yucli。

## T3 只读格式与扫描实现状态（2026-10-29）

- [session.ts](../../src/contracts/session.ts) 提供运行摘要、安全错误、事实数据、恢复业务组及稳定异常；声明事实数据不表示已经接入 core 交付。SessionStore/SessionWriter 和保存屏障仍待后续任务。
- [scanSession.ts](../../src/adapters/session/scanSession.ts) 的 scanSessionFile 拥有并关闭只读 fd；scanSessionHandle 借用已有 fd，不替调用方关闭。初次 fstat 固定 dev/ino/S，显式 read 只解释 `[0,S)`，0x0A 分行、fatal UTF-8；返回 [scanTypes.ts](../../src/adapters/session/scanTypes.ts) 中的 status 判别联合。
- valid 分支包含 validEndBytes、lastLfEndBytes、lastSeq、tailKind、列表统计、无正文 turn/工具证据及最近 20 个完整成功业务组；rejected 分支仅含来源和安全位置/原因，不交付可局部恢复的历史或边界。missing_lf 的完整记录计入 seq/S，incomplete 保留到上一合法 LF 后的 P；仅完整且全套校验合法的记录进入状态机。
- schema 和状态机严格执行第 5 节字段、序号、完整引用/批内顺序/终止边界；独立 JSON 前缀识别器结合 UTF-8 状态判断可完成性，不读取 JSON.parse 错误文字。unknown/not_started 与旧 interruption 由证据推导，不补写事件或重跑工具。
- changing 是前后 fstat 的变化观察，不是原子快照或锁许可。当前 cwd 的 realpath 归属和完整受管目录/文件权限检查仍属 T4/T5；只有未来持锁重扫及必要修复后才能继续执行。T3 不创建日志、不 fsync、不备份/截断/补 LF、不实现列表入口或模型历史投影。

本机目标工具链下 B01–B05 和 B06 只读子集通过，完整结果及未验证平台见[阶段 04 的 T3 实际结果](../specs/phase-04-session-persistence.md#t3-格式与只读扫描实际结果2026-10-29)。B06 的备份修复/sync 重验仍待 T5；整体契约状态保持 draft。

## 错误和退出映射

`SessionAccessError` 表示尚未取得写入权或会话本身不可恢复，例如 `session_busy`、`not_found`、`cwd_mismatch`、`unsupported`、`corrupt`、`invalid_identity`、`permission_denied` 和 `platform_unsupported`。直接 ID 或 `--continue` 失败退出 5；picker 中的候选访问拒绝回到选择器并保留原会话。

`PersistenceError` 表示已进入写入/修复生命周期后无法保证边界，例如 `write_failed`、`sync_failed`、`repair_failed`、`ownership_lost`、`contract_violation`、`close_failed` 和 `io_timeout`。它必须原样穿过 core 和注册表，停止新的模型/工具请求和后续输入，关闭资源后退出 5；不能被转换为 `AbortError`、`protocol_error` 或 `ToolResult(ok:false)`。

业务 turn 的 `failed`、`cancelled` 和 `timeout` 仍按 CLI/REPL 契约处理：先保存唯一非成功 `turn_end`，REPL 不提交历史但可以继续；单次模式退出 4。`turn_end(success)` 确认后，协调方才向 REPL 交付提交凭证。

## 兼容性和版本策略

v1 只接受 `formatVersion: 1`。未知事件、额外字段、非法顺序、未知引用和中间坏行都拒绝，不以“尽量恢复”跳过事实。未来格式变化必须新增版本和迁移/兼容策略；不能让新 writer 通过删除旧事件、改写历史或隐式改变 cwd 规则兼容。

本契约不包含 SQLite 索引、compaction、树分支、短 ID、会话删除、加密、自动清理、跨 cwd 恢复、并发工具或 exactly-once 保证。增加这些能力需要新的阶段范围和 ADR。

## 关联文档、代码和测试

- [阶段 04 规格](../specs/phase-04-session-persistence.md)
- [ADR-006：会话使用严格 JSONL 日志和单写者恢复](../decisions/ADR-006-session-persistence.md)
- [CLI 行为契约](cli.md)的阶段 04 `draft` 扩展
- [REPL 与内存会话契约](repl.md)的阶段 04 `draft` 扩展
- [工具执行契约](tool-execution.md)的阶段 04 `draft` 扩展
- 已实现 T2/T3：`src/contracts/session.ts`、`src/contracts/session-lock.ts` 及 `src/adapters/session/` 内锁/只读扫描；其余 writer/store、`src/core/runPersistentTurn.ts` 和 CLI 接线待后续任务
- 运行时验收：阶段 04 规格第 12 节 C/E 矩阵；实现前不宣称类型声明或锁探针通过即为应用验收
