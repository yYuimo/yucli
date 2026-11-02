/**
 * contracts 层的会话业务数据、写入能力与稳定异常。存储 adapter 校验 JSON 后创建恢复数据，
 * core 通过业务事实/提交凭证协调保存，不接触磁盘 seq、文件句柄或 JSONL。
 * 类型声明在运行时会被擦除；它们不能替代 T3 扫描器的 schema/生命周期检查。
 */
import type { AssistantMessage, TextMessage } from "./message.js";
import type { ToolResult } from "./tool.js";
import type { StreamTurnResult } from "./agent.js";

/** 持久化协调方在唯一成功 turn_end 同步确认后创建；调用方只有取得此凭证才可提交历史。 */
export interface CommittedTurnResult {
  /** 固定成功提交状态，不能用裸 StreamTurnResult 代替保存确认。 */
  status: "committed";
  /** 调用方提供的新 turn 身份；协调方不生成身份或继续旧执行。 */
  turnId: string;
  /** 已完成的业务消息组；凭证不直接修改 REPL 的历史数组。 */
  result: StreamTurnResult;
}

/** adapter 的操作期限与 bootstrap 的故障监督共用的时间能力；测试提供可控实现。 */
export interface PersistenceClock {
  /** 返回单调毫秒时间，仅用于期限；不能用日志 ISO 展示时间代替。 */
  now(): number;
  /** 安排仍能保持进程存活的定时回调，返回取消该定时器的函数；不得 unref。 */
  schedule(delayMs: number, callback: () => void): () => void;
}

/** 公开存储操作的机器名；list 只预留同一期限类型，不表示产品列表已实现。 */
export type SessionOperation = "create" | "open_write" | "append" | "close" | "list";

/** 故障监督使用的真实资源收尾能力，区别于有 30 秒等待上限的业务 close。 */
export interface SessionCleanup {
  /** 停止新操作，等实际 I/O settle 后关闭资源/释放锁；由外层 5 秒监督，不另设等待期限。 */
  closeSettled(): Promise<void>;
}

/** user 外层的运行摘要；创建方显式提供，读取旧记录时允许整个摘要缺失。 */
export interface RuntimeProfile {
  /** 本 turn 实际使用的提供方名称，不包含 endpoint 或认证信息。 */
  provider: string;
  /** 本 turn 实际使用的模型；与 provider 一样必须为非空白字符串。 */
  model: string;
}

/**
 * 可以保存到日志中的安全业务错误，由执行层整理、扫描器复核。
 * 不接受 Error/stack/body 等附加字段；类型合法也不代表已经自动脱敏。
 */
export interface SafeError {
  /** 业务来源；必须与终止 outcome 和规格规定的 code 配对。 */
  category: "model" | "tool" | "protocol" | "limit" | "cancellation" | "timeout" | "internal";
  /** 稳定机器码，例如 invalid_response，不是底层异常文字。 */
  code: string;
  /** 安全摘要，不能保存认证头、响应原文或工具异常堆栈。 */
  message: string;
  /** 可选 HTTP 状态，存在时为 100–599 整数；缺失表示没有该项证据。 */
  httpStatus?: number;
}

/** turn 级异常终止；必须携带与 outcome 匹配的安全错误，不能直接作为工具终止事实。 */
export interface FailureEnd {
  /** failed 是业务失败；cancelled 是取消；timeout 仅代表已实现的请求超时。 */
  outcome: "failed" | "cancelled" | "timeout";
  /** 原因由执行方交付，读取方不能仅凭缺结果合成此对象。 */
  error: SafeError;
}

/**
 * 单项工具可以报告的异常终止，由工具事实交付方创建，adapter 在读取时按同一上下文校验。
 * failed 仅允许工具执行错误，cancelled 保留实际取消检查点；模型、协议、额度等错误属于 turn。
 * SafeError 与具体分类的交叉类型（&）保留安全摘要字段，同时缩小 category/code 的取值。
 * 当前没有工具执行期限，因此不声明 timeout/tool_timeout，也不能套用模型 request_timeout。
 */
export type ToolEnd =
  | { outcome: "failed"; error: SafeError & { category: "tool"; code: "tool_execution_failed" } }
  | {
      outcome: "cancelled";
      error: SafeError & { category: "cancellation"; code: "user_interrupt" | "cancelled_before_dispatch" };
    };

/** 判别联合：success 禁止 error；其余终止状态必须带 error。中断没有落盘的 turn_end。 */
export type TurnEnd = { outcome: "success"; error?: never } | FailureEnd;

/** core 的临时调用引用；磁盘以 callMessageSeq 替换 assistantId，两者不能混用。 */
export interface CallRef {
  /** 当前 turn 内的 a1/a2 等身份，由 core 创建，不写入 JSONL。 */
  assistantId: string;
  /** 沿用模型的调用 ID；只在对应 assistant 批次内唯一。 */
  toolCallId: string;
  /** 沿用调用名称，未知但非空的工具名称也允许作为事实保存。 */
  name: string;
}

/**
 * 执行 core 交给 TurnFactSink 的有序事实数据；不包含协调方负责的 user/turn_end。
 * type 收窄后才能读取相应字段，工具结果必须保留本地 ok 状态。
 */
export type CoreTurnFact = { turnId: string } & (
  | { type: "assistant"; assistantId: string; message: AssistantMessage }
  | { type: "tool_start"; call: CallRef }
  | { type: "tool_result"; call: CallRef; result: ToolResult }
  | { type: "tool_end"; call: CallRef; end: ToolEnd }
);

/**
 * 执行 core 交付已校验事实的保存能力，由 runPersistentTurn 桥接 SessionWriter。
 * 不接收取消 signal：已取得结果或固定终止事实必须等待保存，不因业务取消丢失。
 */
export interface TurnFactSink {
  /**
   * 按业务顺序快照并保存一项事实；调用方逐条 await，成功后才越过对应执行屏障。
   * 持久化故障原样抛出，不重试、不改写为工具结果，不在故障 sink 上递归保存结束事件。
   */
  record(fact: CoreTurnFact): Promise<void>;
}

/** 可选的流式执行上下文；协调方创建，core 不接触文件 seq、存储路径、时钟或锁。 */
export interface TurnExecutionContext {
  /** 当前新 turn 身份；由调用方提供，core 仅沿用，不恢复或继续旧执行。 */
  turnId: string;
  /** 当前 turn 的有序事实保存屏障；缺整个上下文时沿用无持久化路径。 */
  facts: TurnFactSink;
}

/** user/turn_end 的唯一业务所有者是 runPersistentTurn；writer 消费数据，不负责执行业务。 */
export type TurnFact = CoreTurnFact | ({ turnId: string } & (
  | { type: "user"; message: TextMessage & { role: "user" }; runtimeProfile: RuntimeProfile }
  | { type: "turn_end"; end: TurnEnd }
));

/**
 * 会话的有序保存能力，由文件 adapter 创建，协调方逐条 await 使用。
 * 不暴露文件句柄、锁或取消 signal；类型检查不能替代 writer 的运行时契约校验。
 */
export interface SessionWriter {
  /**
   * 在调用时快照事实，完整写入 JSONL + LF 并等待 FileHandle.sync，返回耐久确认序号。
   * 内部串行 I/O；调用方仍须逐条等待屏障。契约/写入/同步/所有权失败后永久拒绝追加，
   * 不重试可能已经写出的记录；关闭开始后也拒绝追加，均抛 PersistenceError。
   */
  appendDurable(fact: TurnFact): Promise<{ confirmedSeq: number }>;

  /**
   * 首次调用停止接受新事实，等待已发出的 I/O，关闭正文后才释放写锁。
   * 重复调用等待同一结果；关闭失败抛 close_failed，30 秒未确认抛 io_timeout。
   * 超时不表示资源已关闭；bootstrap 用 SessionCleanup 的真实 settle 能力继续监督。
   */
  close(): Promise<void>;
}

/** 扫描器从合法 header 提取的会话身份；不含格式版本或平台资源。 */
export interface SessionMeta {
  /** 与受管文件名完全一致的安全身份，新建方将使用 UUID v4。 */
  sessionId: string;
  /** UTC ISO 8601 创建时间，也是文件名时间部分的来源。 */
  createdAt: string;
  /** 创建时规范化的绝对 cwd；真正打开恢复时仍需重新核对当前 cwd。 */
  cwd: string;
}

/** 校验后的成功 turn 内容，仍保留 ToolResult；转换为模型 ToolMessage 属于 T6 core。 */
export type RecoveredItem =
  | { type: "user"; message: TextMessage & { role: "user" } }
  | { type: "assistant"; message: AssistantMessage }
  | { type: "tool_result"; result: ToolResult };

/** 扫描器仅为完整 success 创建此对象；失败/中断 turn 只产生诊断，不能进入成功窗口。 */
export interface RecoveredTurn {
  /** 原 turn 身份，用于整体保留/裁剪；不用于继续旧执行。 */
  turnId: string;
  /** 缺失表示旧日志未提供摘要，不能理解为与当前配置相同。 */
  runtimeProfile?: RuntimeProfile;
  /** 原始业务顺序，去掉 seq、tool_start/end 和 turn_end，不执行工具。 */
  items: readonly RecoveredItem[];
}

/** create/openWrite 交付的业务快照；不含磁盘游标或平台资源，ToolMessage 投影由 T6 core 负责。 */
export interface SessionSnapshot {
  /** 校验后的稳定身份；create 使用真实 cwd，openWrite 保留原身份/时间且重新核对 cwd。 */
  meta: SessionMeta;
  /** create 为空；openWrite 只交付最近 20 个完整成功 turn 的业务数据。 */
  recentSuccessfulTurns: readonly RecoveredTurn[];
  /** 最近 user 的运行摘要；新会话或该 user 没有摘要时缺失，不继承更早 user 的配置。 */
  lastUserProfile?: RuntimeProfile;
  /** 证据推导的中断数量；create 为零。 */
  interruptedTurnCount: number;
  /** 本次打开的尾部动作；完整文件为 none，T5 仅在完整备份后补 LF 或截断残片。 */
  repair: "none" | "truncate_tail" | "append_lf";
}

/** 创建/打开成功后转交调用方的 writer 和独立业务快照；失败不得交付半准备资源。 */
export interface OpenedSession {
  /** 拥有正文与锁的写入能力，调用方负责 close；adapter 同时登记用于整体收尾。 */
  writer: SessionWriter;
  /** 已确认的会话读模型；不能以它授权其他 writer 或重跑旧执行。 */
  snapshot: SessionSnapshot;
}

/** 尚未取得可写会话时的稳定访问分类；锁与扫描共用同一个异常类。 */
export type SessionAccessCode =
  | "session_busy" | "not_found" | "cwd_mismatch" | "unsupported" | "corrupt"
  | "invalid_identity" | "permission_denied" | "platform_unsupported" | "lock_unavailable";

/** 进入存储生命周期后的故障分类；枚举存在不表示 T3 已实现写入、修复或超时。 */
export type PersistenceCode =
  | "write_failed" | "sync_failed" | "repair_failed" | "ownership_lost"
  | "close_failed" | "contract_violation" | "io_timeout";

/**
 * 安全位置上下文，可附于异常；不包含正文或原始 Error。
 * byteOffset 是从零开始的字节位置，line 从 1 开始；缺失表示尚未观察到该项。
 */
export interface SessionErrorContext {
  /** 存储方最后确认的序号；只读扫描的“读到”不等于持久化确认。 */
  lastConfirmedSeq?: number;
  /** 物理行号，不是业务 seq。 */
  line?: number;
  /** 当前记录起点的字节偏移，不能以 JavaScript 字符串长度计算。 */
  byteOffset?: number;
  /** 当前可解析记录的序号与 turn 身份，供定位错误引用。 */
  seq?: number;
  turnId?: string;
  /** 可解析的调用引用；不携带工具参数或工具内容。 */
  callMessageSeq?: number;
  toolCallId?: string;
}

/** 访问拒绝，由未来入口决定重试/退出；本类不输出、不重试、不自行释放资源。 */
export class SessionAccessError extends Error {
  override name = "SessionAccessError";

  /** 保存稳定 code、操作名和安全摘要；可选 context 仅定位，不做任何 I/O。 */
  constructor(
    public readonly code: SessionAccessCode,
    public readonly operation: string,
    message: string,
    public readonly context?: SessionErrorContext,
  ) {
    super(message);
  }
}

/** 保存故障必须原样向上传递，不能转换为工具失败或取消；实际清理由资源所有者执行。 */
export class PersistenceError extends Error {
  override name = "PersistenceError";

  /** 构造安全故障记录；无落盘、重试或进程退出副作用，context 不接受原始异常。 */
  constructor(
    public readonly code: PersistenceCode,
    public readonly operation: string,
    message: string,
    public readonly context?: SessionErrorContext,
  ) {
    super(message);
  }
}
