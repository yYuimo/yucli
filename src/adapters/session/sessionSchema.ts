/** adapters 层的 JSONL v1 运行时结构校验；扫描器先调用本模块，再检查跨记录语义。 */
import { posix } from "node:path";
import type { AssistantMessage } from "../../contracts/message.js";
import type { RuntimeProfile, SessionMeta, ToolEnd, TurnEnd } from "../../contracts/session.js";
import type { ToolResult } from "../../contracts/tool.js";

/** JSONL 首行；版本只属于 header，不混入 core 使用的 SessionMeta。 */
export type SessionHeader = SessionMeta & { type: "session_meta"; formatVersion: 1 };

/** 工具事件的磁盘引用；必须指向同 turn 更早的 assistant，不是临时 assistantId。 */
export interface DiskCallRef {
  /** 提出调用的 assistant 记录序号，正安全整数。 */
  callMessageSeq: number;
  /** 该批调用的原始 ID，不要求跨批唯一。 */
  toolCallId: string;
  /** 原始工具名称；语义校验还会检查与 assistant 中的名称一致。 */
  name: string;
}

/** 每条非 header 记录的公共字段；timestamp 不参与排序，seq 才决定事实顺序。 */
interface Envelope {
  /** 从 1 连续递增的磁盘顺序；通过 schema 后仍需与上一条记录比较。 */
  seq: number;
  /** 记录展示时间，可早于前一条记录，不用于推断先后顺序。 */
  timestamp: string;
  /** 所属业务 turn 的非空白身份；跨记录是否复用由状态机判断。 */
  turnId: string;
}

/**
 * 通过 schema 后的磁盘记录判别联合；仅供 adapter 使用，不传入执行 core。
 * runtimeProfile 只允许出现在 user 的外层，tool_result 的磁盘引用与业务结果共存。
 */
export type SessionRecord = Envelope & (
  | { type: "message"; payload: { role: "user"; content: string }; runtimeProfile?: RuntimeProfile }
  | { type: "message"; payload: AssistantMessage }
  | { type: "tool_start"; payload: DiskCallRef }
  | { type: "tool_result"; payload: DiskCallRef & ToolResult }
  | { type: "tool_end"; payload: DiskCallRef & ToolEnd }
  | { type: "turn_end"; payload: TurnEnd }
);

/** 内部安全校验失败；扫描器捕获后附物理位置，不携带原始 JSON 或底层 Error。 */
export class SessionFormatIssue extends Error {
  /** 保存稳定诊断码和固定摘要；本异常只用于 adapter 内部控制流，无 I/O 副作用。 */
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/**
 * 将 schema/语义校验条件作为拒绝边界；校验函数传入条件、稳定原因码和安全说明。
 * 条件为真时正常返回并帮助 TS 收窄类型，为假时抛 SessionFormatIssue；不做 I/O 或输出。
 */
export function requireSession(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new SessionFormatIssue(code, message);
}

/**
 * 为后续属性检查先确认 JSON 值是对象；所有 header/payload/嵌套结构校验都会调用。
 * 成功将 unknown 收窄为字符串键对象，null/数组/原始值抛 schema，不修改输入。
 */
function object(value: unknown): asserts value is Record<string, unknown> {
  requireSession(typeof value === "object" && value !== null && !Array.isArray(value), "schema", "记录或嵌套字段必须是 JSON 对象。");
}

/**
 * 为一层已确认的 JSON 对象检查精确字段集合；各事件校验传入必填及可选键列表。
 * 成功无返回值，缺字段或多字段抛 schema；不删除字段或填默认值，避免误接收新格式。
 */
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  requireSession(
    required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    "schema", "字段缺失或存在 v1 不允许的附加字段。",
  );
}

/** 判定身份、工具名等是否为非空白字符串；保留原值，不 trim 后改写日志。 */
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 判断 seq/引用是否为正安全整数，避免浮点精度导致不同记录被视为同一序号。 */
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * 验证 UTC ISO 8601 时间，允许省略或提供小数秒，拒绝时区偏移和 Date 自动归一化的坏日期。
 * 只校验展示时间形状；扫描器不要求相邻记录时间单调递增。
 */
function utcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;

  // Date 会把 2 月 30 日推到 3 月，因此比较年月日时分秒；不把 JS 毫秒精度
  // 误当成日志允许的小数位数上限，原 timestamp 的精度和文本始终保留。
  return new Date(milliseconds).toISOString().slice(0, 19) === value.slice(0, 19);
}

/**
 * 读取第一行的身份/版本，并与受管 basename 配对；由扫描器在任何业务记录之前调用。
 * 返回校验后的 header；未知整数版本抛 unsupported，其他非法结构抛 schema/identity。
 * cwd 这里只检查规范绝对路径形状；与当前 cwd 的 realpath 归属复核属于后续 openWrite。
 */
export function validateSessionHeader(value: unknown, sourceBasename: string): SessionHeader {
  object(value);
  requireSession(value.type === "session_meta", "schema", "第一物理行必须是 session_meta。");
  requireSession(Number.isInteger(value.formatVersion), "schema", "格式版本必须是整数。");
  requireSession(value.formatVersion === 1, "unsupported", "会话格式版本不受支持。");
  fields(value, ["type", "formatVersion", "sessionId", "createdAt", "cwd"]);

  requireSession(typeof value.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId), "identity", "会话身份不符合受管命名规则。");
  requireSession(utcTimestamp(value.createdAt), "schema", "创建时间不是合法 UTC ISO 8601 时间。");
  requireSession(
    typeof value.cwd === "string" && posix.isAbsolute(value.cwd) && !value.cwd.includes("\0") && posix.resolve(value.cwd) === value.cwd,
    "schema", "创建目录必须为规范绝对路径。",
  );

  const filename = `${value.createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${value.sessionId}.jsonl`;
  requireSession(sourceBasename === filename, "identity", "header 身份或创建时间与受管文件名不一致。");
  return { type: "session_meta", formatVersion: 1, sessionId: value.sessionId, createdAt: value.createdAt, cwd: value.cwd };
}

/**
 * user 校验发现外层 runtimeProfile 存在时，检查 provider/model 完整、非空且无额外键。
 * 输入来自未知 JSON；成功无返回值，非法时抛 schema，不从当前环境补配置或修改原对象。
 */
function runtimeProfile(value: unknown): void {
  object(value);
  fields(value, ["provider", "model"]);
  requireSession(nonblank(value.provider) && nonblank(value.model), "schema", "运行摘要需要非空 provider/model。");
}

/**
 * 校验完整 assistant 文本及整批调用；未知工具名称合法，但调用结构和参数必须与阶段 02 一致。
 * 这是存储格式校验，不导入 core 注册表、不查询工具、不执行文件操作。
 */
function assistant(value: Record<string, unknown>): void {
  fields(value, ["role"], ["content", "toolCalls"]);
  requireSession(!Object.hasOwn(value, "content") || typeof value.content === "string", "schema", "assistant.content 必须为字符串。");

  if (Object.hasOwn(value, "toolCalls")) {
    requireSession(Array.isArray(value.toolCalls) && value.toolCalls.length <= 4, "schema", "工具批次必须是最多四项的数组。");
    const ids = new Set<string>();
    for (const call of value.toolCalls) {
      object(call);
      fields(call, ["id", "name", "argumentsJson"]);
      requireSession(
        nonblank(call.id) && nonblank(call.name) &&
        typeof call.argumentsJson === "string" && !ids.has(call.id),
        "schema", "工具调用身份、名称、参数或同批唯一性非法。",
      );
      ids.add(call.id);

      let args: unknown;
      try {
        args = JSON.parse(call.argumentsJson) as unknown;
      } catch {
        throw new SessionFormatIssue("schema", "工具参数不是合法 JSON。");
      }
      object(args);
      fields(args, ["path"]);
      requireSession(typeof args.path === "string", "schema", "工具参数必须恰好包含字符串 path。");
    }
  }

  requireSession(
    Array.isArray(value.toolCalls) && value.toolCalls.length > 0 || nonblank(value.content),
    "schema", "无工具调用的最终 assistant 必须有非空白文本。",
  );
}

/**
 * 为 tool_start/result/end 检查序号、ID、名称的基本形状；输入已经是 payload 对象。
 * 成功无返回值，类型非法抛 schema；目标存在/同 turn/名称配对留给状态机，不执行工具。
 */
function callReference(value: Record<string, unknown>): void {
  requireSession(positiveInteger(value.callMessageSeq) && nonblank(value.toolCallId) && nonblank(value.name), "schema", "工具引用需要合法序号、调用 ID 和名称。");
}

/**
 * 在指定事件上下文中检查终止状态；tool_end/turn_end 结构分支显式传入事件类型。
 * 输入为 payload 对象，成功无返回值，非法 outcome、错误结构或配对均抛 schema。
 * 安全错误的字段检查共用，允许的原因分别判断，避免把模型/协议/额度错误认作工具失败。
 * 本函数只校验数据；当前工具没有执行期限，tool_end(timeout) 即使有错误对象也拒绝。
 */
function termination(value: Record<string, unknown>, kind: "tool_end" | "turn_end"): void {
  if (value.outcome === "success") {
    requireSession(kind === "turn_end" && !Object.hasOwn(value, "error"), "schema", "success 不允许 error，也不能作为 tool_end。");
    return;
  }

  // 先检查事件允许的 outcome，再检查安全错误；request_timeout 只属于模型请求，
  // 不能因为 SafeError/FailureEnd 包含 timeout 枚举就提前允许工具超时。
  const outcomes = kind === "tool_end" ? ["failed", "cancelled"] : ["failed", "cancelled", "timeout"];
  requireSession(outcomes.includes(value.outcome as string), "schema", "当前终止事件的 outcome 非法或尚未支持。");
  object(value.error);
  fields(value.error, ["category", "code", "message"], ["httpStatus"]);
  requireSession(
    nonblank(value.error.category) && nonblank(value.error.code) && nonblank(value.error.message),
    "schema", "安全错误需要字符串分类、机器码和非空白摘要。",
  );
  requireSession(
    !Object.hasOwn(value.error, "httpStatus") ||
    Number.isInteger(value.error.httpStatus) &&
    (value.error.httpStatus as number) >= 100 && (value.error.httpStatus as number) <= 599,
    "schema", "安全 HTTP 状态必须为 100–599 的整数。",
  );

  const pair = `${value.error.category}/${value.error.code}`;
  if (kind === "tool_end") {
    // 工具取消沿用两个实际观察点；普通 failed 必须明确来自工具执行。
    // 这里只限制记录含义，不推断 execute 是否发生，也不合成工具结果。
    const toolPairs = value.outcome === "failed" ? ["tool/tool_execution_failed"]
      : ["cancellation/user_interrupt", "cancellation/cancelled_before_dispatch"];
    requireSession(toolPairs.includes(pair), "schema", "tool_end 只能保存工具执行失败或合法工具取消。");
    return;
  }

  // turn_end 保留完整的业务终止原因；其模型请求超时仍使用 request_timeout。
  const allowed = value.outcome === "cancelled" ? ["cancellation/user_interrupt", "cancellation/cancelled_before_dispatch"]
    : value.outcome === "timeout" ? ["timeout/request_timeout"]
    : [
        "model/network", "model/http", "model/invalid_response", "protocol/protocol_error",
        "limit/loop_limit", "tool/tool_execution_failed", "internal/internal_error",
      ];
  requireSession(allowed.includes(pair), "schema", "终止 outcome 与安全错误分类/机器码不匹配。");
}

/**
 * 将 JSON.parse 的 unknown 逐层验证为 v1 记录，供每条完整行和 missing_lf 行调用。
 * 先公共字段、再事件 payload；返回只代表结构合法，跨记录引用和顺序仍须由状态机验证。
 * 失败抛内部安全错误，不修改输入、不补字段，也不把附加字段静默丢掉。
 */
export function validateSessionRecord(value: unknown): SessionRecord {
  object(value);
  object(value.payload);
  const user = value.type === "message" && value.payload.role === "user";
  fields(value, ["seq", "type", "timestamp", "turnId", "payload"], user ? ["runtimeProfile"] : []);
  requireSession(positiveInteger(value.seq) && nonblank(value.turnId) && utcTimestamp(value.timestamp), "schema", "记录的 seq、turnId 或 UTC 时间非法。");

  switch (value.type) {
    case "message":
      if (user) {
        fields(value.payload, ["role", "content"]);
        requireSession(nonblank(value.payload.content), "schema", "user 内容必须为非空白字符串。");
        if (Object.hasOwn(value, "runtimeProfile")) runtimeProfile(value.runtimeProfile);
      } else {
        requireSession(value.payload.role === "assistant", "schema", "v1 只保存 user/assistant 消息。");
        assistant(value.payload);
      }
      break;
    case "tool_start":
      fields(value.payload, ["callMessageSeq", "toolCallId", "name"]);
      callReference(value.payload);
      break;
    case "tool_result":
      fields(value.payload, ["callMessageSeq", "toolCallId", "name", "ok", "content"]);
      callReference(value.payload);
      requireSession(typeof value.payload.ok === "boolean" && typeof value.payload.content === "string", "schema", "工具结果需要布尔 ok 和字符串 content。");
      break;
    case "tool_end":
      fields(value.payload, ["callMessageSeq", "toolCallId", "name", "outcome", "error"]);
      callReference(value.payload);
      termination(value.payload, "tool_end");
      break;
    case "turn_end":
      fields(value.payload, ["outcome"], ["error"]);
      termination(value.payload, "turn_end");
      break;
    default:
      throw new SessionFormatIssue("schema", "未知 v1 记录类型或重复 header。");
  }

  // 断言只放在全部运行时检查之后；它不会执行任何校验，也不能用来绕过上面的分支。
  return value as unknown as SessionRecord;
}
