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
| `TurnFactSink` | 将 core 的完整 assistant/工具事实按顺序转交给 writer，并等待确认 | fire-and-forget 事件广播、原始 Error 或取消 signal |
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
| `tool_end` | `{callMessageSeq,toolCallId,name,outcome,error}` | 没有正常结果的工具失败/取消；当前不允许工具 timeout |
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

`tool_end` 只接受 `failed/tool/tool_execution_failed`、`cancelled/cancellation/user_interrupt` 和 `cancelled/cancellation/cancelled_before_dispatch`。模型、协议、额度和未分类内部错误属于 turn，不能作为工具异常终止；`turn_end` 继续接受规格的完整配对。当前读写均拒绝 `tool_end(timeout)`，不能误用模型的 `request_timeout`，也不提前接受尚未定义的 `tool_timeout`。以后增加工具超时必须先定义执行期限及独立错误码/契约。

## 跨层接口

以下是实现必须提供的业务边界。TypeScript 类型检查不能替代运行时 JSON、顺序、引用和 cwd 校验。

```ts
type RuntimeProfile = { provider: string; model: string };

type FailureEnd = {
  outcome: "failed" | "cancelled" | "timeout";
  error: SafeError;
};

type ToolEnd =
  | { outcome: "failed"; error: SafeError & { category: "tool"; code: "tool_execution_failed" } }
  | { outcome: "cancelled"; error: SafeError & { category: "cancellation"; code: "user_interrupt" | "cancelled_before_dispatch" } };

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

type CommittedTurnResult = {
  status: "committed";
  turnId: string;
  result: StreamTurnResult;
};

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

尾部修复只允许在原 S 补一个 LF，或截断到上一合法 LF 后的 P。备份逐字节包含完整 [0,S)（含残片），与清单用同一新时间戳/UUID、wx 创建；全部文件及必要目录同步后，仍需再次核对原件 dev/ino、大小和 SHA-256 才能修改。修改后对同一正文 fd sync，并重新扫描检查 tailKind=none、lastSeq、有效字节边界和实际大小。

2026-10-29 用户确认的失败边界：修改前失败保证本操作不改变正文；修改生效后 sync/重验失败保留真实字节和完整备份，不回滚、不重试旧边界、不交付 writer。一般修复故障为 repair_failed，描述符关闭不确定仍报 close_failed 并保留锁/登记。重新打开必须依据实际文件证据，健康文件不重复备份。

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

T2 锁能力已实现，后续 T3/T4/T5 分别追加扫描、文件/writer、存储恢复/修复，T6 追加 core 事实交付/纯模型投影，T7 追加协调器/操作期限/可注入故障监督；本文整体仍为 draft，完整 SessionStore/list、产品 CLI 接线和真实退出子进程验收仍待后续任务。

- [SessionLockAdapter](../../src/adapters/session/SessionLockAdapter.ts) 的 preflight 不创建目录/锁；acquire(sessionId) 以 exnb 返回 SessionLock，assertOwnership 检查路径/描述符 dev/ino 和目录身份，release 等检查完成后关闭描述符，保留稳定锁文件。调用方必须先关闭正文再释放。
- probe(sessionId) 对已有文件以只读 fd + shnb 返回 busy/available/unknown；本进程登记直接 busy，不为自己的锁增加 fd。缺路径/能力不明为 unknown，探测结果不授权写入。根默认 ~/.yucli，可注入隔离根；根的父目录需存在，T2 不代建 home。
- probe(sessionId) 的清理是存储屏障：shnb/所有权检查结束后必须关闭只读 fd；关闭失败不降级为 `unknown`，而是抛 `PersistenceError`（`code: "close_failed"`、`operation: "probe_cleanup"`）。上层列表或恢复将该故障按存储失败收尾，最终退出码为 5；`unknown` 只表示状态/能力无法可靠判断且本次资源清理成功。
- [lockPlatform](../../src/adapters/session/lockPlatform.ts) 精确检查 macOS arm64 + Node 24.14.0，再按需加载 fs-ext，并只读检查本地挂载；失败在创建前抛 platform_unsupported 或 lock_unavailable。没有 mkdir/心跳/无锁降级。
- T2 的锁接口放在 [session-lock.ts](../../src/contracts/session-lock.ts)；T3 将稳定错误统一至 [session.ts](../../src/contracts/session.ts)，旧入口重导出同一个类以保留 instanceof 身份。已有占用为 session_busy，取锁后身份变更为 ownership_lost，任一锁描述符（包括 probe 的只读 fd）关闭失败为 close_failed。
- local 检查使用 macOS mount 的显式 local 标记、最近已存在祖先和最长路径段匹配；未知/非 local 拒绝，不声称识别所有共享挂载或隔离并发父目录替换。只验证本机 APFS，不承诺其他环境。
- T2 不提供 create/openWrite/list/appendDurable/close 的 30 秒期限与 5 秒故障退出；这些依然是完整 SessionStore/writer/T7 的待实现要求。锁适配器不会在 native 调用未 settle 时提前关闭或解锁。

安装工具链、原生构建授权和 D01–D03/D06 子集的实际验证见[阶段 04 的 T2 实际结果](../specs/phase-04-session-persistence.md#t2-依赖与锁实际结果2026-10-29)。锁测试全部在临时目录，未访问真实 ~/.yucli。

## T3 只读格式与扫描实现状态（2026-10-29）

- [session.ts](../../src/contracts/session.ts) 在 T3 提供运行摘要、安全错误、事实数据、恢复业务组及稳定异常；声明事实数据不表示已经接入 core 交付。T4 追加 SessionWriter/空快照类型及下节文件保存屏障，完整 SessionStore 仍待后续任务。
- [scanSession.ts](../../src/adapters/session/scanSession.ts) 的 scanSessionFile 拥有并关闭只读 fd；scanSessionHandle 借用已有 fd，不替调用方关闭。初次 fstat 固定 dev/ino/S，显式 read 只解释 `[0,S)`，0x0A 分行、fatal UTF-8；返回 [scanTypes.ts](../../src/adapters/session/scanTypes.ts) 中的 status 判别联合。
- valid 分支包含 validEndBytes、lastLfEndBytes、lastSeq、tailKind、列表统计、无正文 turn/工具证据及最近 20 个完整成功业务组；rejected 分支仅含来源和安全位置/原因，不交付可局部恢复的历史或边界。missing_lf 的完整记录计入 seq/S，incomplete 保留到上一合法 LF 后的 P；仅完整且全套校验合法的记录进入状态机。
- schema 和状态机严格执行第 5 节字段、序号、完整引用/批内顺序/终止边界；独立 JSON 前缀识别器结合 UTF-8 状态判断可完成性，不读取 JSON.parse 错误文字。unknown/not_started 与旧 interruption 由证据推导，不补写事件或重跑工具。
- T3 审查修正将 tool_end 类型/运行时配对收窄为工具失败或取消；turn 级错误和工具 timeout 拒绝。SessionSequence 明确为单次使用，accept 失败后或 finish 成功后继续 accept/finish 均抛安全的 validator_state，不返回失败后的局部历史，也不改变已交付摘要。直接 API 和文件扫描反例已验证，详见阶段实际结果中的“T3 审查修正”。
- changing 是前后 fstat 的变化观察，不是原子快照或锁许可。T4 为新建补充 cwd realpath/目录归属及受管路径权限检查；已有文件的可写恢复仍须 T5 持锁重扫和必要修复。T3 扫描本身不创建日志、不 fsync、不备份/截断/补 LF、不实现列表入口或模型历史投影。

本节仅记录 T3 的 B01–B05 和 B06 只读子集证据，结果及未验证平台见[阶段 04 的 T3 实际结果](../specs/phase-04-session-persistence.md#t3-格式与只读扫描实际结果2026-10-29)。B06 的存储修复/sync 重验由后文 T5 实现；整体契约状态保持 draft。

## T4 文件与 writer 实现状态（2026-10-29）

- [SessionFileAdapter](../../src/adapters/session/SessionFileAdapter.ts) 在 T4 交付时提供 create/资源级 close，供未来完整 store 组合，T5 再扩展 openWrite。新建先 T2 预检，再核对真实目录 cwd 和私有受管目录；UUID v4/路径碰撞最多三次。正文以 wx 独占语义 + NOFOLLOW 创建 0600，复核路径/fd 身份，完整 header、文件及 sessions/locks/root/根父目录同步后才交付 writer 和空快照，之后调用方再 append user。
- [SessionWriterAdapter](../../src/adapters/session/SessionWriterAdapter.ts) 实现本契约 SessionWriter。入口快照并校验事实，实际 I/O 串行；磁盘结构/生命周期复用 T3，短写按实际字节补齐，sync 与所有权复核成功才返回 confirmedSeq。已确认 assistantId 映射转换为 callMessageSeq，批次间复用 toolCallId 继续按 T3 引用规则配对，turn_end 确认后清除本地身份。
- write/sync、契约、所有权故障后永久拒绝 append，不重试不确定行。关闭首次停止接收，等已发出的操作 settle，所有正文/目录 fd 关闭成功才调用原 T2 release；重复 close 等待同一结果。关闭失败保留锁与资源登记，不再次 close 不确定 fd。文件 adapter 同时登记未交付的 create，成功关闭后才撤销资源登记。
- [sessionFileIO](../../src/adapters/session/sessionFileIO.ts) 的窄能力、时钟、UUID 和已有 T2 锁能力均支持注入，默认委托真实 Node/T2；没有新增依赖、生产假模型或 CLI 根路径开关。所有测试用显式临时根，T3 双扫描入口核验实际落盘字节；目标 Node 下 T4 新增 69 项、全部 590 项通过。
- 本节为 T4 当时交付的保存/资源边界；后文 T5 扩展 openWrite/备份修复，完整 SessionStore/list、core 事实交付、30 秒/5 秒监督和 CLI 仍待后续任务。关闭失败保留资源需要后续 T7 监督，不得在 I/O 未 settle 时提前解锁；T4 当时的完整报告见阶段规格。

## T5 存储恢复与修复实现状态（2026-10-29）

- SessionFileAdapter.openWrite 对规范真实 cwd 和完整安全 ID 只读定位，排除缺失/同 ID 多文件；T2 预检/独占锁成功后再正式重定位，r+ + NOFOLLOW/NONBLOCK 打开正文，不带创建、覆盖或追加标志。逐项复核受管目录/文件权限、所有者、普通文件/单硬链接、dev/ino 和大小，借用同一正文 fd 做 T3 全文件扫描。扫描拒绝为 unsupported/corrupt，归属不符为 cwd_mismatch，准备期间身份/内容变化为 ownership_lost；不改选、不重放。
- 完整文件不备份、不改字节，同步当前合法前缀后建立 writer 起点。[repairSession](../../src/adapters/session/repairSession.ts) 对两类合法尾部执行上述保全/修改/重验流程；备份、清单、recovery 容器为 0600/0700。原件/备份/清单核对实际 UTF-8 字节及摘要；保留前缀摘要还用于确认修复没有重写旧 JSON。全部成功前不允许新执行。
- 快照只含原 meta、最近最多 20 个完整 success 的业务组、最近 user 摘要（缺失保持缺失）、中断数量和本次 repair。adapter 不生成 ToolMessage，不把 seq/assistantId 交给 core。原清单的纯模型投影已正式移至 T6 core 任务。
- SessionSequence.forAppend 建立新校验器，继承已校验 seq 和所有旧 turnId 的拒绝集合；不复活已 finish 的实例、不重建旧 assistant/tool 状态。续写从 lastSeq+1 开始，header-only 从 1 开始，继续共用 T4 的短写、同步、永久故障及幂等 close。备份/目录/正文 fd 全部由同一 writer 登记；openWrite 在首次 await 前登记，close 等实际 settle/关闭正文后才放锁，关闭失败仍保持登记。
- 目标 macOS arm64 / Node 24.14.0 / pnpm 10.33.2 下，新增 102 项 T5 测试，全部 15 个文件、692 项测试及 typecheck/lint/build 通过。B06–B09 和 D04 的存储子集验证使用临时目录、可控 I/O/Promise，不访问真实 home/.env 或模型；不宣称已验证 CLI、进程中断监督或其他平台。
- T5 实现通过验证，并获用户授权独立提交；阶段仍 implementing、契约仍 draft。T5 当时未实现 list/picker、core 事实交付/模型投影、30 秒/5 秒监督或 CLI/REPL 接线；T6 core 子集见下节，T5 完整结果见阶段规格的开发报告。

## T6 core 事实交付与纯模型投影实现状态（2026-10-29）

- [session.ts](../../src/contracts/session.ts) 新增 `TurnFactSink` 与 `TurnExecutionContext` 能力接口，沿用既有 CoreTurnFact/CallRef。`runTurnStream` 通过末尾可选上下文逐条等待已完整校验的 assistant 和逐项工具事实；不生成 user/turn_end，不返回提交凭证。T7 协调器及其 turn 终止、历史提交、监督仍未实现。
- [toolRegistry.ts](../../src/core/toolRegistry.ts) 保留整批预检和顺序执行，start 确认前不分派，result 确认前不执行后项。合法完整工具输出先成为 ToolResult 并交付，再观察取消；内部异常通过 ToolExecutionError 安全分类，保存拒绝原样穿透，不递归结束、不重试。
- [toolMessage.ts](../../src/core/toolMessage.ts) 提供实时/兼容路径和恢复共用的 `toolResultToMessage`；[sessionHistory.ts](../../src/core/sessionHistory.ts) 的 `projectSessionHistory(turns: readonly RecoveredTurn[]): Message[][]` 只消费 T5 已验证的成功组，按文件顺序整组取最后 20 个，显式复制模型字段与嵌套调用。失败/取消/超时/中断由 T5 排除，不另造 outcome，不把 seq/assistantId/profile/ok 送入模型，不重跑工具或请求。
- adapter 继续只返回业务快照，不 import core；当前没有 bootstrap 恢复/持久化接线。目标环境新增 57 项测试，17 个文件、749 项及 typecheck/lint/build 全部通过；T6 已获用户授权独立提交，完整报告见阶段规格。

## T7 协调与操作/收尾期限实现状态（2026-10-29）

- [runPersistentTurn.ts](../../src/core/runPersistentTurn.ts) 接收对象输入（writer、turnId、runtimeProfile、client、registry、model、history、prompt、onText、可选 signal），不生成身份。它是唯一 user/turn_end 所有者：先确认 user，再用 T6 sink 桥接 writer；最终 assistant 确认后观察取消并固定 outcome，只在唯一 turn_end(success) 确认后返回 CommittedTurnResult。终止保存等待期间不再观察/改写 outcome；业务失败保存安全终止后重抛原异常，PersistenceError 在每个保存点原样穿透、不补终止/重试。history 始终由调用方持有。
- 安全错误配对严格使用规格 §6 的既定码。所有落盘 message 为固定安全摘要，不复制原始 Error.message/stack/responseSummary；HTTP 状态仅在 http 且为 100–599 整数时复制。已取消的 signal 不传入 append；最终 assistant 保存期间发生取消仍可在固定终止前生效，固定后不再变更。
- [sessionOperation.ts](../../src/adapters/session/sessionOperation.ts) 的 SessionOperations 给 create/openWrite/appendDurable/close 设置固定 30,000 ms 总等待，单调时钟及 schedule 可注入，默认定时器不 unref。list 只保留同一操作名类型，无列表实现。计时含排队与内部步骤；超时永久固定共享 io_timeout、阻止后继 I/O，保留原 Promise 并观察晚到成功/拒绝，不取消底层调用、不确认迟到写入。
- 文件 adapter 的 preparing 和 writer 的 tail 继续登记原 Promise；不能改为登记已超时的等待 Promise。SessionCleanup.closeSettled 是故障/内部清理专用能力：停止新操作，等待真实 settle，再关正文/备份/目录 fd、最后释放锁。它不受业务 close 的 30 秒等待 Promise 影响，必须由 bootstrap 的 5 秒监督约束；不是供业务绕过期限的第二个普通 close。
- [persistenceSupervisor.ts](../../src/bootstrap/persistenceSupervisor.ts) 首次故障固定原异常、唯一 5,000 ms 总期限和重入结果，调用注入的 stopInput/cancel/真实 close 回调。资源证实关闭则返回 5；挂起或关闭失败到期输出固定安全摘要并调用注入 exit(5)，不提前解锁。迟到拒绝持续观察；输出/取消失败不覆盖初始故障。生产组合根实际注入 process.exit、输入控制与信号接线留 T8/T9，本轮单元测试使用退出替身。
- 目标 macOS arm64 / Node 24.14.0 / pnpm 10.33.2 下新增 79 项、3 个测试文件，全部 20 文件/828 项及 typecheck/lint/build 通过。验证含真实临时文件/T2 锁、本地 mock SSE、可控 Promise/时钟；T7 未提交待审查，不表示 T8 产品持久化入口或 T9 真实退出子进程已验收。

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
- 已实现 T2–T7 子集：contracts 会话业务数据/提交凭证、adapters 的锁/扫描/writer/恢复修复/操作期限，以及 core 事实交付/纯投影/持久化协调和 bootstrap 可注入故障监督；完整 store/list、实际 CLI 接线及退出子进程验收待后续任务
- 运行时验收：阶段 04 规格第 12 节 C/E 矩阵；实现前不宣称类型声明或锁探针通过即为应用验收
