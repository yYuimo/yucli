/** contracts 层的 T2 锁边界；不包含 T3 的日志格式、writer 或 SessionStore。 */

/** 取写入权前的锁访问失败；busy 可重试，能力/平台失败不能降级成另一种锁。 */
export type LockAccessCode =
  | "session_busy" | "lock_unavailable" | "platform_unsupported"
  | "invalid_identity" | "permission_denied";

/**
 * 锁适配器拒绝访问时交付的稳定异常，未来由会话入口决定用户可见行为。
 * code 供程序分类，operation 标明安全的操作名；message 不得含路径、原始异常或凭证。
 * 只保存诊断，不自行输出、退出或重试；T2 不接入 CLI 的退出码映射。
 */
export class SessionAccessError extends Error {
  override name = "SessionAccessError";

  /** 创建锁访问错误；调用方 throw 后才中断流程，无 I/O 或终端副作用。 */
  constructor(
    public readonly code: LockAccessCode,
    public readonly operation: string,
    message: string,
  ) {
    super(message);
  }
}

/** 已持锁后的所有权或关闭失败；不能作为普通工具错误或用户取消吞掉。 */
export type LockPersistenceCode = "ownership_lost" | "close_failed";

/**
 * 锁生命周期已进入后发生的存储故障，供上层停止后继操作并安排资源清理。
 * 当前仅实现 T2 所需分类；30 秒存储操作期限及故障退出监督留给 T7。
 * 不携带底层 Error、不自行解锁或结束进程。
 */
export class PersistenceError extends Error {
  override name = "PersistenceError";

  /** 保存稳定的故障 code、operation 与安全说明；无文件操作和自动重试。 */
  constructor(
    public readonly code: LockPersistenceCode,
    public readonly operation: string,
    message: string,
  ) {
    super(message);
  }
}

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
