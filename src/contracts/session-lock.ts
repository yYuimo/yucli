/** contracts 层的锁能力；稳定异常统一由 session.ts 定义，这里保留 T2 的导出入口。 */
export { SessionAccessError, PersistenceError } from "./session.js";

/** 取写入权前的锁访问失败；busy 可重试，能力/平台失败不能降级成另一种锁。 */
export type LockAccessCode =
  | "session_busy" | "lock_unavailable" | "platform_unsupported"
  | "invalid_identity" | "permission_denied";

/** 已持锁后的所有权或关闭失败；不能作为普通工具错误或用户取消吞掉。 */
export type LockPersistenceCode = "ownership_lost" | "close_failed";

/** 只读占用探测结果；unknown 不能当作可写许可，available 也必须重新取得 exnb。 */
export type LockWriterState = "busy" | "available" | "unknown";

/**
 * 一次 exnb 成功取得的内核锁能力，由锁适配器创建并交给未来的会话资源所有者。
 * 本接口不提供原始 fd，调用方不能提前关闭它或绕过释放生命周期。
 */
export interface SessionLock {
  /**
   * 复核锁路径、父目录和当前描述符的身份；不续租、不刷新心跳。
   * 正常返回表示当前观测一致，替换/删除/权限变化或已关闭时抛 ownership_lost。
   * 失败不提前解锁，仍需调用 release；不能提供与后继写入原子隔离的 OS 沙箱保证。
   */
  assertOwnership(): Promise<void>;

  /**
   * 等待已发出的所有权检查 settle，再关闭描述符，让内核释放锁；重复调用等待同一结果。
   * 上层必须先等待自身文件 I/O 并关闭正文，然后才能调用；本方法不掌握正文生命周期。
   * 正常不删除稳定锁文件；关闭失败抛 close_failed 并保留进程内登记，不假装可再次取得。
   */
  release(): Promise<void>;
}
