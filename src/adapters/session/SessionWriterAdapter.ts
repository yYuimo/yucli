/** adapters 层的 T4 新文件 writer；拥有正文/临时目录句柄与 T2 写锁，不提供恢复打开。 */
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PersistenceError, SessionAccessError } from "../../contracts/session.js";
import type { SessionMeta, SessionWriter, TurnFact } from "../../contracts/session.js";
import type { SessionLock } from "../../contracts/session-lock.js";
import { prepareSessionFact, SessionFactEncoder } from "./sessionFact.js";
import {
  fileErrorCode, requirePrivateSessionPath, sameSessionIdentity, SessionIdentityCollision,
  type SessionFileIO,
} from "./sessionFileIO.js";
import { SessionSequence } from "./sessionSequence.js";
import { validateSessionHeader } from "./sessionSchema.js";

/** 创建前已检查的受管目录身份；运行中持续复核，不将 lstat 当成原子沙箱。 */
export interface SessionDirectories {
  /** 应用根及其身份，包含 sessions 和由 T2 管理的 locks。 */
  root: BigIntStats;
  /** 扁平正文容器的身份；目录替换后不能继续向旧 inode 追加。 */
  sessions: BigIntStats;
}

/**
 * 新会话的底层资源所有者，由 SessionFileAdapter 在取得锁后立即登记。
 * initialize 成功前不交付 SessionWriter；任何失败都保留产物，等待 close 实际结束后才解锁。
 */
export class SessionWriterAdapter implements SessionWriter {
  private readonly handles = new Set<FileHandle>();
  private readonly handleCloses = new Map<FileHandle, Promise<void>>();
  private readonly encoder = new SessionFactEncoder();
  private readonly sequence: SessionSequence;
  private body: FileHandle | undefined;
  private identity: BigIntStats | undefined;
  private directories: SessionDirectories | undefined;
  private position = 0;
  private recordStart = 0;
  private confirmedSeq = 0;
  private initialized = false;
  private fault: PersistenceError | undefined;
  /** tail 始终 fulfilled，仅表示实际操作已 settle，原失败通过对应 append Promise 交付。 */
  private tail: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  readonly basename: string;
  private readonly path: string;

  /**
   * 保存已取得的锁及注入 I/O/时钟/身份，由创建器调用；构造不打开文件、不写 header。
   * 后续资源均登记在 handles 中；meta 是创建器独立对象，用户快照不能反向修改；
   * onClosed 仅在正文关闭和放锁成功后通知创建器撤销登记，失败则仍由创建器持有资源。
   */
  constructor(
    private readonly root: string,
    private readonly meta: SessionMeta,
    private readonly lock: SessionLock,
    private readonly io: SessionFileIO,
    private readonly now: () => Date,
    private readonly onClosed: () => void,
  ) {
    this.basename = `${meta.createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${meta.sessionId}.jsonl`;
    this.path = join(root, "sessions", this.basename);
    this.sequence = new SessionSequence(meta.createdAt);
  }

  /**
   * 仅供创建器调用一次：持锁检查 ID 碰撞，wx 独占打开最终正文，校验身份并同步 header/目录。
   * 返回前不允许 user 写入；失败产物不 unlink、不覆盖。文件名碰撞单独交给创建器最多重试三次。
   * 此 Promise 由创建器的准备资源登记覆盖，不能在它 settle 前关闭/释放本资源。
   */
  async initialize(directories: SessionDirectories): Promise<void> {
    this.directories = directories;
    const header = validateSessionHeader({ type: "session_meta", formatVersion: 1, ...this.meta }, this.basename);
    await this.lock.assertOwnership();
    await this.verifyDirectories();
    const names = await this.io.readdir(join(this.root, "sessions"));

    // 时间与 ID 分开捕获，不能用 suffix 把带下划线的另一个身份误当同 ID。
    const managed = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d+)?Z_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/u;
    if (names.some((name) => managed.exec(name)?.[1] === this.meta.sessionId)) throw new SessionIdentityCollision();

    try {
      // 与 wx+ 相同的独占创建，同时拒绝末端 symlink；绝不使用会覆盖文件的 w/a+。
      this.body = await this.io.open(
        this.path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600,
      );
      this.handles.add(this.body);
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") throw new SessionIdentityCollision();
      throw new SessionAccessError("permission_denied", "create_open", "无法独占创建会话正文。");
    }

    // 在写入第一个字节前检查路径和 fd，避免把“创建成功”当成文件身份已可信。
    this.identity = await this.body.stat({ bigint: true });
    requirePrivateSessionPath(this.identity, false);
    if (this.identity.size !== 0n) throw new SessionAccessError("invalid_identity", "create_open", "新建正文必须为空。");
    await this.assertOwnership();
    await this.writeLine(header, "header");

    // header 已 fsync，再确认正文目录、锁目录、根及根的父目录项。
    // 即使根由 T2 刚刚创建，也必须确认根自身在其父目录中的条目；不 chmod 父目录。
    for (const path of [join(this.root, "sessions"), join(this.root, "locks"), this.root, dirname(this.root)]) {
      await this.syncDirectory(path);
    }
    await this.assertOwnership();
    this.initialized = true;
    this.recordStart = this.position;
  }

  /**
   * 复核创建时 root/sessions 的 dev/ino 和私有权限；创建与每个保存检查点共用。
   * 路径/权限/所有者变化以 ownership_lost 抛出，不自动修正，也不关闭仍在使用的 fd。
   */
  private async verifyDirectories(): Promise<void> {
    try {
      const root = await this.io.lstat(this.root);
      const sessions = await this.io.lstat(join(this.root, "sessions"));
      requirePrivateSessionPath(root, true);
      requirePrivateSessionPath(sessions, true);
      if (!this.directories || !sameSessionIdentity(root, this.directories.root) || !sameSessionIdentity(sessions, this.directories.sessions)) {
        throw new Error("directory identity changed");
      }
    } catch {
      throw this.failure("ownership_lost", "assert_ownership", "会话目录的身份或权限已改变。");
    }
  }

  /**
   * 在写入前和 sync 后复核 T2 锁、受管目录及正文路径/fd 的 dev/ino、权限和预期大小。
   * 失败永久进入故障；这些检查点无法隔离外部编辑器的同大小写入或所有父目录竞态。
   */
  private async assertOwnership(): Promise<void> {
    try {
      await this.lock.assertOwnership();
      await this.verifyDirectories();
      const path = await this.io.lstat(this.path);
      const descriptor = await this.body!.stat({ bigint: true });
      requirePrivateSessionPath(path, false);
      requirePrivateSessionPath(descriptor, false);
      if (
        !this.identity || !sameSessionIdentity(path, this.identity) || !sameSessionIdentity(descriptor, this.identity) ||
        descriptor.size !== BigInt(this.position) || path.size !== descriptor.size
      ) throw new Error("body identity or size changed");
    } catch {
      throw this.failure("ownership_lost", "assert_ownership", "会话正文、目录或写锁的身份已改变。");
    }
  }

  /**
   * 创建路径时打开并 fsync 一个必要目录，再关闭临时 fd；目录句柄从打开起就归本资源管理。
   * 同时复核路径/描述符身份，受管目录另查私有权限；失败不跳过目录确认或提前解锁。
   */
  private async syncDirectory(path: string): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await this.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.handles.add(handle);
      const descriptor = await handle.stat({ bigint: true });
      const entry = await this.io.lstat(path);
      if (!descriptor.isDirectory() || !sameSessionIdentity(descriptor, entry)) throw new Error("directory changed");
      if (path !== dirname(this.root)) requirePrivateSessionPath(descriptor, true);
      await this.io.sync(handle);
    } catch {
      throw this.failure("sync_failed", "create_directory_sync", "新会话的必要目录同步失败。");
    }
    await this.closeHandle(handle);
  }

  /**
   * 将已校验对象编码为 JSON + LF，循环补齐短写，然后等待 FileHandle.sync 并复核身份。
   * position 按实际确认的 bytesWritten 前进；write 抛错时可能已经落字节，不猜测、不重试。
   * 零进度/非法计数同为 write_failed；sync 失败保留未确认行，交由未来重新打开扫描判断。
   */
  private async writeLine(value: unknown, operation: string): Promise<void> {
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(value) + "\n"); }
    catch { throw this.failure("contract_violation", operation, "会话记录无法编码为 UTF-8 JSONL。"); }
    let offset = 0;
    while (offset < bytes.length) {
      try {
        const count = await this.io.write(this.body!, bytes.subarray(offset), this.position);
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error("invalid write progress");
        offset += count;
        this.position += count;
      } catch {
        throw this.failure("write_failed", operation, "会话记录未取得完整写入确认。");
      }
    }
    try { await this.io.sync(this.body!); }
    catch { throw this.failure("sync_failed", operation, "会话记录未取得文件同步确认。"); }
    await this.assertOwnership();
  }

  /**
   * 在交付时快照/结构校验并固定时间，再将实际 encode/sequence/write/sync 串行排队。
   * 只有全部确认后才推进 confirmedSeq 和本地 assistant 映射；后续失败不会重试不确定行。
   * 返回 Promise 是该事实的屏障，排队成功不表示保存成功；无取消 signal 或后台提交。
   */
  appendDurable(fact: TurnFact): Promise<{ confirmedSeq: number }> {
    if (this.fault) return Promise.reject(this.fault);
    if (this.closing || !this.initialized) {
      return Promise.reject(new PersistenceError("contract_violation", "append", "会话尚未就绪或已开始关闭，不能追加。"));
    }
    let prepared;
    try { prepared = prepareSessionFact(fact, this.now().toISOString()); }
    catch { return Promise.reject(this.failure("contract_violation", "append", "交付事实不符合会话契约。")); }

    // 此回调只在前一操作真正 settle 后运行；故障会阻止所有尚未发出的后继写入。
    const task = this.tail.then(async () => {
      if (this.fault) throw this.fault;
      const seq = this.confirmedSeq + 1;
      let record;
      try {
        record = this.encoder.encode(prepared, seq);
        this.sequence.accept(record);
      } catch {
        throw this.failure("contract_violation", "append", "事实的序号、引用或生命周期不符合会话契约。");
      }
      await this.assertOwnership();
      await this.writeLine(record, "append");

      // durable 提交点：校验器的 lastSeq 只是内存游标，绝不能提前作为保存确认。
      this.confirmedSeq = seq;
      this.encoder.confirm(prepared.fact, seq);
      this.recordStart = this.position;
      return { confirmedSeq: seq };
    });
    // 同时观察两种 settle，close 可等待它且不会制造额外未处理拒绝。
    this.tail = task.then(() => {}, () => {});
    return task;
  }

  /** 生成并保留首次安全故障，附最后确认 seq 与当前已知字节位置；不写错误事件或原始异常。 */
  private failure(code: PersistenceError["code"], operation: string, message: string): PersistenceError {
    this.fault ??= new PersistenceError(code, operation, message, { lastConfirmedSeq: this.confirmedSeq, byteOffset: this.recordStart });
    return this.fault;
  }

  /**
   * 关闭一个登记过的句柄，成功才从资源集移除；临时目录清理和最终 close 共用。
   * 失败保留句柄和锁，不在同一资源上重试 close；公开错误不携带底层路径/异常。
   */
  private closeHandle(handle: FileHandle): Promise<void> {
    let task = this.handleCloses.get(handle);
    if (!task) {
      // 保留关闭结果，即便失败也不再向可能已被系统复用的 fd 发第二次 close。
      task = (async () => {
        try { await this.io.close(handle); }
        catch { throw new PersistenceError("close_failed", "close", "会话描述符关闭失败。", { lastConfirmedSeq: this.confirmedSeq, byteOffset: this.recordStart }); }
        this.handles.delete(handle);
      })();
      this.handleCloses.set(handle, task);
    }
    return task;
  }

  /**
   * 首次调用立即拒绝新 append，等已发出的 I/O 实际 settle，再关闭所有正文/目录 fd 并释放锁。
   * 每条成功记录已同步，无须在故障尾部额外补写/同步；不产生 session_end。
   * 任何 fd 关闭失败都保留锁，重复 close 等待同一拒绝结果；不进入 T7 的期限/强制退出逻辑。
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.tail;
      let closeError: unknown;
      for (const handle of this.handles) {
        try { await this.closeHandle(handle); }
        catch (error) { closeError ??= error; }
      }
      if (closeError) throw closeError;
      await this.lock.release();
      this.onClosed();
    })();
    return this.closing;
  }
}
