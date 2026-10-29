/** adapters 内部的扁平会话命名规则；创建碰撞检查与持锁恢复共用，不读取或修正正文。 */
import type { SessionMeta } from "../../contracts/session.js";
import { SessionAccessError } from "../../contracts/session.js";

/** 名称解析只用于定位候选；header 的时间合法性、身份配对仍由 T3 全文件扫描确认。 */
export type SessionFileIdentity = Pick<SessionMeta, "sessionId" | "createdAt">;

/** 检查外部 sessionId 能否作为单一路径段；定位前调用，失败抛 invalid_identity，无 I/O。 */
export function requireSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(sessionId)) {
    throw new SessionAccessError("invalid_identity", "open_write", "会话身份不符合受管命名规则。");
  }
}

/** 从稳定身份生成受管 basename；创建和 writer 使用同一替换规则，不访问文件系统。 */
export function sessionBasename(meta: SessionFileIdentity): string {
  return `${meta.createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${meta.sessionId}.jsonl`;
}

/**
 * 为目录定位提取名称中的时间和完整 ID，非受管形状返回 undefined，不支持任意路径。
 * 正则分别捕获时间/身份，避免用后缀匹配把带下划线的其他身份误认为同一会话。
 */
export function parseSessionBasename(name: string): SessionFileIdentity | undefined {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)(?:-(\d+))?Z_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/u.exec(name);
  if (!match) return undefined;
  return {
    sessionId: match[6]!,
    createdAt: `${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] === undefined ? "" : `.${match[5]}`}Z`,
  };
}
