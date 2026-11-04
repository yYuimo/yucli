/** adapters 层的业务事实快照和本地引用转换；磁盘格式/顺序严格复用 T3 校验器。 */
import type { TurnFact } from "../../contracts/session.js";
import { requireSession, validateSessionRecord, type SessionRecord } from "./sessionSchema.js";

/** 每次 append 入口快照的交付值；timestamp 在交付时取一次，不随 I/O 等待改变。 */
export interface PreparedSessionFact {
  /** 与调用方对象隔离的深拷贝；只有运行时结构校验通过才赋为 TurnFact。 */
  fact: TurnFact;
  /** adapter 注入时钟生成的 UTC ISO 时间；T3 schema 负责合法性检查。 */
  timestamp: string;
}

/**
 * prepareSessionFact 用 value/keys 检查内存事实外壳或引用的精确字段；成功收窄为对象，
 * 失败抛安全 SessionFormatIssue，不修改输入；payload 内容规则全部交给 T3 schema。
 */
function localFields(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireSession(typeof value === "object" && value !== null && !Array.isArray(value), "fact", "事实及本地引用必须为对象。");
  requireSession(
    keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key)),
    "fact", "事实或本地引用字段缺失或包含附加字段。",
  );
}

/** 入口快照校验 assistantId 非空白；成功收窄为字符串，失败抛安全契约原因，不改原值或落盘。 */
function assistantIdentity(value: unknown): asserts value is string {
  requireSession(typeof value === "string" && value.trim().length > 0, "fact", "assistantId 必须为非空白字符串。");
}

/**
 * 把已快照的业务事实包成 T3 磁盘记录；调用方提供 seq/time 和已确认的 assistant seq。
 * 工具字段只转换引用，不删改消息/错误；额外 payload 字段由 T3 schema 拒绝。
 */
function diskRecord(fact: TurnFact, seq: number, timestamp: string, callMessageSeq = 1): SessionRecord {
  const envelope = { seq, timestamp, turnId: fact.turnId };
  switch (fact.type) {
    case "user":
      return validateSessionRecord({ ...envelope, type: "message", payload: fact.message, runtimeProfile: fact.runtimeProfile });
    case "assistant":
      return validateSessionRecord({ ...envelope, type: "message", payload: fact.message });
    case "turn_end":
      return validateSessionRecord({ ...envelope, type: "turn_end", payload: fact.end });
    default: {
      const ref = { callMessageSeq, toolCallId: fact.call.toolCallId, name: fact.call.name };
      const payload = fact.type === "tool_result" ? { ...ref, ...fact.result }
        : fact.type === "tool_end" ? { ...ref, ...fact.end } : ref;
      return validateSessionRecord({ ...envelope, type: fact.type, payload });
    }
  }
}

/**
 * 在 append 的首次 await 前深拷贝并校验交付数据，防止排队期间被调用方修改。
 * 本地精确字段与结果引用配对在这里检查，磁盘 payload 复用 validateSessionRecord；
 * 此时仅用占位正整数检查引用形状，真正目标必须在实际写入前从已确认映射中取得。
 * 非法数据/不可克隆数据抛异常，由 writer 转为永久 contract_violation，不产生 I/O。
 */
export function prepareSessionFact(input: TurnFact, timestamp: string): PreparedSessionFact {
  // 这里只给属性访问一个字典视图，下面仍先检查对象形状，不把断言当运行时校验。
  const value = structuredClone(input) as unknown as Record<string, unknown>;
  requireSession(typeof value === "object" && value !== null && "type" in value, "fact", "缺少事实类型。");
  const keys = value.type === "user" ? ["type", "turnId", "message", "runtimeProfile"]
    : value.type === "assistant" ? ["type", "turnId", "assistantId", "message"]
    : value.type === "turn_end" ? ["type", "turnId", "end"]
    : value.type === "tool_start" ? ["type", "turnId", "call"]
    : value.type === "tool_result" ? ["type", "turnId", "call", "result"]
    : value.type === "tool_end" ? ["type", "turnId", "call", "end"] : undefined;
  requireSession(keys, "fact", "未知业务事实类型。");
  localFields(value, keys);
  if (value.type === "assistant") assistantIdentity(value.assistantId);
  if (value.type === "user") requireSession(value.runtimeProfile !== undefined, "fact", "新 user 必须交付运行摘要。");
  if (value.type === "tool_start" || value.type === "tool_result" || value.type === "tool_end") {
    localFields(value.call, ["assistantId", "toolCallId", "name"]);
    assistantIdentity(value.call.assistantId);
    if (value.type === "tool_result") {
      localFields(value.result, ["toolCallId", "name", "ok", "content"]);
      requireSession(
        value.result.toolCallId === value.call.toolCallId && value.result.name === value.call.name,
        "fact", "工具结果的 ID/名称与本地调用引用不匹配。",
      );
    }
    if (value.type === "tool_end") localFields(value.end, ["outcome", "error"]);
  }

  // 断言只跨过本地外壳；下面马上用 T3 校验所有消息、profile、安全错误和磁盘字段。
  const fact = value as unknown as TurnFact;
  const record = diskRecord(fact, 1, timestamp);
  requireSession(
    fact.type !== "user" || record.type === "message" && record.payload.role === "user",
    "fact", "user 事实必须交付 user 消息。",
  );
  requireSession(
    fact.type !== "assistant" || record.type === "message" && record.payload.role === "assistant",
    "fact", "assistant 事实必须交付 assistant 消息。",
  );
  return { fact, timestamp };
}

/**
 * 当前 turn 的临时 assistantId → 已确认 seq，由单个 writer 持有。
 * 不按 toolCallId 建跨批映射；T3 SessionSequence 继续负责名称/批内顺序/生命周期。
 */
export class SessionFactEncoder {
  private turnId: string | undefined;
  private readonly assistants = new Map<string, number>();

  /**
   * 在串行写入前把已准备事实转换为磁盘记录；只读已确认映射，失败不登记新引用。
   * 重复 assistantId、跨 turn 或未知本地引用抛安全契约错误，调用方随后执行 T3 sequence。
   */
  encode({ fact, timestamp }: PreparedSessionFact, seq: number): SessionRecord {
    if (fact.type === "assistant") {
      requireSession(this.turnId === fact.turnId && !this.assistants.has(fact.assistantId), "fact", "assistantId 必须在当前 turn 内唯一。");
    }
    let callMessageSeq: number | undefined;
    if (fact.type === "tool_start" || fact.type === "tool_result" || fact.type === "tool_end") {
      callMessageSeq = this.turnId === fact.turnId ? this.assistants.get(fact.call.assistantId) : undefined;
      requireSession(callMessageSeq !== undefined, "fact", "工具引用必须指向当前 turn 已确认的 assistant。");
    }
    return diskRecord(fact, seq, timestamp, callMessageSeq);
  }

  /**
   * 完整写入并同步成功后才登记/清理映射；输入是本次已确认事实和实际 seq，无 I/O。
   * 新 user 隔离旧中断 turn，turn_end 清除临时身份；恢复不重建旧执行的 a1/a2。
   */
  confirm(fact: TurnFact, seq: number): void {
    if (fact.type === "user" || fact.type === "turn_end") {
      this.assistants.clear();
      this.turnId = fact.type === "user" ? fact.turnId : undefined;
    } else if (fact.type === "assistant") {
      this.assistants.set(fact.assistantId, seq);
    }
  }
}
