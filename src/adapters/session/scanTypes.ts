/** adapters 内部只读扫描结果；与未来 SessionStore 的列表/可写快照不同，不授予执行或写入权。 */
import type { RecoveredTurn, RuntimeProfile, SessionErrorContext, SessionMeta, ToolEnd, TurnEnd } from "../../contracts/session.js";
import type { DiskCallRef } from "./sessionSchema.js";

/** 从 fstat 取得的稳定来源快照；bigint 防止 dev/ino 经过 number 丢失精度。 */
export interface ScanSource {
  /** 仅文件名，用于诊断与 header 配对，不向执行 core 暴露本地完整路径。 */
  sourceBasename: string;
  /** 初次打开描述符所属设备；不以路径字符串代替实体身份。 */
  dev: bigint;
  /** 同一次 fstat 的 inode；与 dev 共同标识被扫描实体。 */
  ino: bigint;
  /** 初始 S；扫描只能解释 [0,S)，不是扫描结束时的文件大小。 */
  observedSizeBytes: number;
  /** 扫描前后 fstat 的大小/时间证据发生变化；false 也不承诺并发快照隔离。 */
  changing: boolean;
}

/** 对拒绝文件的安全诊断；物理位置来自字节扫描，正文和底层错误不进入此结构。 */
export interface ScanDiagnostic extends SessionErrorContext {
  /** schema/sequence/reference/lifecycle/json/utf8 等稳定原因码。 */
  code: string;
  /** 固定安全说明，不包含原始字段值或工具输出。 */
  message: string;
  /** 当前物理行的右开字节边界；LF 存在时包括 LF。 */
  lineEndBytes: number;
}

/**
 * 工具执行证据摘要；扫描器按完整引用创建，不猜测缺记录的外部结果。
 * result 保留 ok；ended 保留安全原因；不会把这些诊断合成为模型工具消息。
 */
export type ScannedCall = DiskCallRef & (
  | { state: "result"; ok: boolean }
  | { state: "ended"; end: ToolEnd }
  | { state: "not_started" }
  | { state: "unknown" }
);

/** 一个已校验 turn 的诊断摘要；失败和中断也保留已知工具状态，但不含原始业务文本。 */
export interface ScannedTurn {
  /** turn 起点身份，用于定位而非继续旧 turn。 */
  turnId: string;
  /** 该 turn 唯一 user 的磁盘序号，不是 turn 内重新编号。 */
  userSeq: number;
  /** 缺 turn_end 才是 interrupted；不能把未知工具结果推导为 cancelled。 */
  outcome: TurnEnd["outcome"] | "interrupted";
  /** 文件中实际存在的安全终止原因；interrupted 不合成 end。 */
  end?: TurnEnd;
  /** 按 assistant 批次和批内顺序排列的全部调用证据。 */
  calls: readonly ScannedCall[];
}

/** 列表未来可复用的只读统计；不含 writerState、锁探测、选择或恢复决策。 */
export interface ScanStatistics {
  /** 最后一条合法记录时间；无记录时使用 header.createdAt，不要求时间单调。 */
  lastActivityAt: string;
  /** 全部合法 user 起点数，不仅统计成功历史。 */
  turnCount: number;
  /** 缺 turn_end 的 turn 数，不把合法 failed/cancelled/timeout 计为中断。 */
  interruptedTurnCount: number;
  /** 按文件顺序最后一个 turn 的结果；header-only 为 null。 */
  lastTurnOutcome: ScannedTurn["outcome"] | null;
  /** 首条 user 的单行安全摘要，最多 80 个 Unicode 码点。 */
  preview: string;
  /** 最近 user 的摘要；缺失不代表可采用更早 user 的配置。 */
  lastUserProfile?: RuntimeProfile;
}

/**
 * 语法和业务均有效的扫描前缀；incomplete/missing_lf 仍需未来持锁重扫和修复。
 * 此结果不等于可写快照，不能仅凭本次只读观察开始模型或工具执行。
 */
export interface ValidScanResult extends ScanSource {
  /** 仅代表扫描前缀合法；不代表已持锁、已修复或可以执行。 */
  status: "valid";
  /** 经过格式和受管 basename 一致性校验的身份。 */
  meta: SessionMeta;
  /** 所有合法记录前缀末端 P 或 S，不是最后成功 turn 的末端。 */
  validEndBytes: number;
  /** 最后一条合法 LF 行之后的右开字节位置。 */
  lastLfEndBytes: number;
  /** 所有合法记录的最后 seq；完整但缺 LF 的记录也计入。 */
  lastSeq: number;
  /** none 已有 LF；missing_lf 是完整记录；incomplete 仅为可完成语法残片。 */
  tailKind: "none" | "missing_lf" | "incomplete";
  /** 按规格优先级映射；历史中任一 interruption 都会保留 interrupted 状态。 */
  logState: "complete" | "interrupted" | "torn_tail" | "missing_lf" | "empty";
  /** 列表后续可复用的统计；writerState 和恢复授权须另行计算。 */
  statistics: ScanStatistics;
  /** 只保存最近 20 个完整 success 的业务组，不为失败或中断保留正文缓存。 */
  recentSuccessfulTurns: readonly RecoveredTurn[];
  /** 诊断按 turn 保留，不携带消息正文；不会在文件中补写这些推导状态。 */
  turns: readonly ScannedTurn[];
}

/** 拒绝联合分支刻意不提供可恢复前缀/历史，防止调用方误把坏文件的好部分交给模型。 */
export interface RejectedScanResult extends ScanSource {
  /** 必须拒绝整个文件，不能对已经读到的好 turn 局部恢复。 */
  status: "rejected";
  /** unsupported 专指 header 版本；corrupt 包括编码/JSON/schema/语义错误。 */
  tailKind: "corrupt" | "unsupported";
  /** 只读列表可以展示的拒绝状态，不提供执行历史。 */
  logState: "corrupt" | "unsupported";
  /** 第一处拒绝的位置及安全原因；不携带原始消息正文。 */
  diagnostic: ScanDiagnostic;
}

/** 调用方先检查 status，再访问合法历史；拒绝文件永远没有“可继续的局部历史”。 */
export type ScanResult = ValidScanResult | RejectedScanResult;
