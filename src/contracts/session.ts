/**
 * contracts 层的会话业务数据与稳定异常。存储 adapter 校验 JSON 后创建恢复数据，
 * 后续 core 只消费这里的业务消息，不接触磁盘 seq、文件句柄或 JSONL。
 * 类型声明在运行时会被擦除；它们不能替代 T3 扫描器的 schema/生命周期检查。
 */
import type { AssistantMessage, TextMessage } from "./message.js";
import type { ToolResult } from "./tool.js";

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

/** 工具或 turn 的异常终止；必须携带与 outcome 匹配的安全错误。 */
export interface FailureEnd {
  /** failed 是业务失败；cancelled 是取消；timeout 仅代表已实现的请求超时。 */
  outcome: "failed" | "cancelled" | "timeout";
  /** 原因由执行方交付，读取方不能仅凭缺结果合成此对象。 */
  error: SafeError;
}

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
 * 执行层可交付的有序事实数据；这里只声明数据，不接入 sink 或执行流程。
 * type 收窄后才能读取相应字段，工具结果必须保留本地 ok 状态。
 */
export type CoreTurnFact = { turnId: string } & (
  | { type: "assistant"; assistantId: string; message: AssistantMessage }
  | { type: "tool_start"; call: CallRef }
  | { type: "tool_result"; call: CallRef; result: ToolResult }
  | { type: "tool_end"; call: CallRef; end: FailureEnd }
);

/** user/turn_end 的业务所有者是后续协调方；本类型不实现 writer、确认屏障或协调器。 */
export type TurnFact = CoreTurnFact | ({ turnId: string } & (
  | { type: "user"; message: TextMessage & { role: "user" }; runtimeProfile: RuntimeProfile }
  | { type: "turn_end"; end: TurnEnd }
));

/** 扫描器从合法 header 提取的会话身份；不含格式版本或平台资源。 */
export interface SessionMeta {
  /** 与受管文件名完全一致的安全身份，新建方将使用 UUID v4。 */
  sessionId: string;
  /** UTC ISO 8601 创建时间，也是文件名时间部分的来源。 */
  createdAt: string;
  /** 创建时规范化的绝对 cwd；真正打开恢复时仍需重新核对当前 cwd。 */
  cwd: string;
}

/** 校验后的成功 turn 内容，仍保留 ToolResult；转换为模型 ToolMessage 属于后续 core。 */
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
