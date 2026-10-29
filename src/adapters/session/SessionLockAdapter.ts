/** adapters 层的稳定 sidecar flock；仅提供 T2 锁能力，不打开任何会话正文。 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PersistenceError, SessionAccessError } from "../../contracts/session-lock.js";
import type { LockWriterState, SessionLock } from "../../contracts/session-lock.js";
import { preflightLock } from "./lockPlatform.js";
import type { LockPlatformOptions, NativeFlock } from "./lockPlatform.js";

/** 由 bootstrap 或测试注入的组装参数；不新增目录覆盖 CLI/env。 */
export interface SessionLockOptions extends LockPlatformOptions {
  /** 默认 ~/.yucli；测试必须传临时根。根的父目录必须已经存在，不代替调用方创建 home。 */
  storageRoot?: string;
}

/**
 * 进程级写者登记，包括还在异步预检/取锁中的申请；不同 adapter 实例共用。
 * sessionId 是会话身份，同一进程即使通过不同根路径/别名重复申请也保守拒绝。
 * 登记不是替代内核锁：跨进程排他性仍完全依赖 exnb。
 */
const writers = new Map<string, symbol>();

/** 安全提取 Node 错误码，供访问/冲突分类；不把原始异常内容交给外层。 */
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** 判断 flock 非阻塞冲突；只有这两个内核码表示忙碌，其余错误不可伪装为冲突。 */
function isBusy(error: unknown): boolean {
  return errorCode(error) === "EAGAIN" || errorCode(error) === "EWOULDBLOCK";
}

/**
 * 将 fs-ext callback 包装为 Promise，供 acquire/probe 等待真实内核操作 settle。
 * native/fd/operation 为已验证模块、现有句柄和 exnb/shnb；失败保留原码给调用方分类。
 * 不设置会提前丢弃底层操作的超时，不自动重试，不在 callback 完成前关闭描述符。
 */
function flock(native: NativeFlock, handle: FileHandle, operation: "exnb" | "shnb"): Promise<void> {
  return new Promise((resolve, reject) => {
    // 回调只交付本次内核调用的结果；resolve 表示锁已取得，不表示路径身份已验证。
    native.flock(handle.fd, operation, (error) => error ? reject(error) : resolve());
  });
}

/**
 * 校验路径/句柄是当前用户私有的目录或普通单链接文件；不自动 chmod 不合规产物。
 * stats 用 bigint 保持 dev/ino 精确；owner/type/mode 不合规抛访问拒绝，持锁检查会转 ownership_lost。
 */
function requirePrivate(stats: BigIntStats, directory: boolean): void {
  if (
    stats.uid !== BigInt(process.getuid!()) || (stats.mode & 0o077n) !== 0n ||
    (directory ? !stats.isDirectory() : !stats.isFile() || stats.nlink !== 1n)
  ) throw new SessionAccessError("permission_denied", "lock_path", "锁路径的类型、所有者或权限不符合要求。");
}

/** 按 dev/ino 比较同一实体，不依赖大小、mtime、PID 或文件中的占位信息。 */
function sameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

/**
 * 读取根和 locks 目录身份且拒绝末端符号链接，供创建后、开锁前和持锁复核共用。
 * 输入为受管路径，返回两份 lstat 快照；不创建、不改权限，不扫描或读写会话正文。
 */
async function directoryIdentities(root: string): Promise<readonly [BigIntStats, BigIntStats]> {
  const rootInfo = await lstat(root, { bigint: true });
  const locksInfo = await lstat(join(root, "locks"), { bigint: true });
  requirePrivate(rootInfo, true);
  requirePrivate(locksInfo, true);
  return [rootInfo, locksInfo];
}

/**
 * 复核打开的 inode、锁路径和目录快照是否仍一致，取得锁后和运行中按需调用。
 * 描述符可能仍锁着被移走的旧 inode，只有 flock 成功不足以证明路径仍指向它。
 * 检查失败抛 ownership_lost，不自动解锁或删除新路径；外层仍须关闭旧句柄。
 */
async function verifyOwnership(
  root: string,
  path: string,
  handle: FileHandle,
  originalFile: BigIntStats,
  originalDirectories: readonly [BigIntStats, BigIntStats],
): Promise<void> {
  try {
    const currentDirectories = await directoryIdentities(root);
    const currentFile = await lstat(path, { bigint: true });
    const descriptor = await handle.stat({ bigint: true });
    requirePrivate(currentFile, false);
    requirePrivate(descriptor, false);
    if (
      !sameIdentity(originalFile, currentFile) || !sameIdentity(originalFile, descriptor) ||
      !sameIdentity(originalDirectories[0], currentDirectories[0]) ||
      !sameIdentity(originalDirectories[1], currentDirectories[1])
    ) throw new Error("identity changed");
  } catch {
    throw new PersistenceError("ownership_lost", "assert_ownership", "锁路径或所持描述符的身份已改变。");
  }
}

/**
 * 关闭一个锁描述符，将关闭失败整理为 close_failed；释放、申请失败清理和只读探测共用。
 * 等待真实 close settle 后才返回；不以超时假装已释放，不删除路径，不自行撤销登记。
 * 关闭故障优先于访问结果，因为此时无法确认资源已释放。
 */
async function closeDescriptor(handle: FileHandle, operation: string): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw new PersistenceError("close_failed", operation, "锁描述符关闭失败。");
  }
}

/**
 * 封装已取得的写锁，隐藏 fd 并提供所有权检查、幂等释放；acquire 成功时创建。
 * 不管理正文 I/O；调用方必须先关闭正文再 release。所有权故障后不恢复为健康状态。
 */
function heldLock(check: () => Promise<void>, handle: FileHandle, unregister: () => void): SessionLock {
  const pending = new Set<Promise<void>>();
  let fault: PersistenceError | undefined;
  let closing: Promise<void> | undefined;
  return {
    /** 登记本次检查，避免 release 与尚未 settle 的 fstat/lstat 并发关闭同一描述符。 */
    assertOwnership(): Promise<void> {
      if (fault) return Promise.reject(fault);
      if (closing) return Promise.reject(new PersistenceError("ownership_lost", "assert_ownership", "锁已开始释放。"));
      const task = check().catch((error: PersistenceError) => {
        // 一旦失去身份保证就保持故障，不能因为原路径后来被换回来而继续写。
        fault = error;
        throw error;
      });
      pending.add(task);
      // 两条分支均删除已结束检查；此观察链不会制造未处理的拒绝 Promise。
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },

    /** 只启动一次关闭；等待检查结束后关闭 fd，内核随描述符关闭释放 flock，保留锁文件。 */
    release(): Promise<void> {
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        // 未确认关闭就不能解除进程内登记或授权后继写者；不尝试更弱的解锁方案。
        await closeDescriptor(handle, "release");
        unregister();
      })();
      return closing;
    },
  };
}

/**
 * 提供稳定锁写入权与只读占用探测，未来由存储组装层调用；当前不接入 CLI。
 * 无 PID/心跳/年龄清理，无 mkdir 占位锁；目录 mkdir 只用于容纳真正的 flock sidecar。
 */
export class SessionLockAdapter {
  private readonly root: string;

  /** 保存依赖与存储根，构造本身不加载 native、不创建目录、不取得锁。 */
  constructor(private readonly options: SessionLockOptions = {}) {
    this.root = resolve(options.storageRoot ?? join(homedir(), ".yucli"));
  }

  /** 只读预检入口，返回前验证平台、native 与 local 挂载，不产生锁文件或持久化目录。 */
  async preflight(): Promise<void> {
    await preflightLock(this.root, this.options);
  }

  /**
   * 为指定会话取得非阻塞独占锁，返回由调用方持有到会话关闭的 SessionLock。
   * sessionId 只允许单一路径段；先登记准备状态、完成预检，再创建私有根/locks 与 0600 文件。
   * flock 成功后必须复核路径/dev/ino；冲突为 session_busy，能力失败为 lock_unavailable，
   * 身份变化为 ownership_lost。失败等真实 I/O settle 后关闭 fd，不删除稳定文件。
   */
  async acquire(sessionId: string): Promise<SessionLock> {
    const path = this.lockPath(sessionId);
    if (writers.has(sessionId)) throw new SessionAccessError("session_busy", "acquire", "本进程已持有或正在申请此会话。");
    const token = Symbol(sessionId);
    writers.set(sessionId, token);
    let handle: FileHandle | undefined;
    let transferred = false;

    /** 仅当前申请完成关闭时撤销自己的登记，不能误删另一申请的资源身份。 */
    const unregister = () => { if (writers.get(sessionId) === token) writers.delete(sessionId); };
    try {
      // 1. 平台/本地文件系统/native 能力拒绝必须发生在任何 mkdir/open-create 之前。
      const native = await preflightLock(this.root, this.options);
      await this.ensureDirectories();
      const directories = await directoryIdentities(this.root);

      // 2. 不用 w/truncate；O_NOFOLLOW 拒绝末端链接，NONBLOCK 防止意外特殊文件阻塞打开。
      // 文件即使已存在也保留全部内容；锁身份来自内核 inode，而不是文件内的数据。
      handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const identity = await handle.stat({ bigint: true });
      requirePrivate(identity, false);
      try {
        await flock(native, handle, "exnb");
      } catch (error) {
        if (isBusy(error)) throw new SessionAccessError("session_busy", "acquire", "会话已被其他写者占用。");
        throw new SessionAccessError("lock_unavailable", "acquire", "无法取得原生会话锁。");
      }

      // 3. fd 持有的旧 inode 不够；复核仍是受管路径指向的实体，才可把写锁交付给调用方。
      const ownedHandle = handle;
      const check = () => verifyOwnership(this.root, path, ownedHandle, identity, directories);
      await check();
      const lock = heldLock(check, ownedHandle, unregister);
      transferred = true;
      return lock;
    } catch (error) {
      if (error instanceof SessionAccessError || error instanceof PersistenceError) throw error;
      throw new SessionAccessError("permission_denied", "acquire", "无法安全打开会话锁路径。");
    } finally {
      // 申请失败仍要等 flock 已结束后才能关闭；不使用 Promise.race 提前丢弃真实内核操作。
      if (!transferred) {
        if (handle) await closeDescriptor(handle, "acquire_cleanup");
        unregister();
      }
    }
  }

  /**
   * 用只读句柄对已有文件做短暂 shnb 探测，返回 busy/available/unknown，不授予写入权。
   * 本进程登记直接返回 busy，避免额外 fd 干扰自己的锁；native/平台/路径不确定返回 unknown。
   * 缺失根或锁不创建任何路径。取得共享锁后也复核身份，最后关闭 fd，正常保留稳定文件。
   */
  async probe(sessionId: string): Promise<LockWriterState> {
    const path = this.lockPath(sessionId);
    if (writers.has(sessionId)) return "busy";
    let handle: FileHandle | undefined;
    try {
      const native = await preflightLock(this.root, this.options);
      const directories = await directoryIdentities(this.root);
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const identity = await handle.stat({ bigint: true });
      requirePrivate(identity, false);
      try { await flock(native, handle, "shnb"); }
      catch (error) {
        if (isBusy(error)) return "busy";
        return "unknown";
      }
      await verifyOwnership(this.root, path, handle, identity, directories);
      return "available";
    } catch {
      return "unknown";
    } finally {
      // 列表探测没有写者身份可交付；关闭成功才能算本次探测资源已结束，失败为存储故障。
      if (handle) await closeDescriptor(handle, "probe_cleanup");
    }
  }

  /** 根据安全 sessionId 生成唯一 sidecar 路径；拒绝目录穿越、分隔符、空值及过长输入。 */
  private lockPath(sessionId: string): string {
    if (typeof sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(sessionId)) {
      throw new SessionAccessError("invalid_identity", "lock_path", "会话身份不能作为受管锁文件名。");
    }
    return join(this.root, "locks", `${sessionId}.lock`);
  }

  /**
   * 预检通过后仅创建根与 locks 两级容器，随后用 lstat 验证现有路径，拒绝 symlink/宽权限。
   * EEXIST 只表示已有候选路径，必须检查而不能当作目录已安全；不递归 mkdir 或自动 chmod。
   */
  private async ensureDirectories(): Promise<void> {
    for (const path of [this.root, join(this.root, "locks")]) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      requirePrivate(await lstat(path, { bigint: true }), true);
    }
  }
}
