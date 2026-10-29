/** adapters 层 T4 会话创建与资源登记；未来 SessionStore 可组合它，不实现 openWrite/list/repair。 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenedSession, SessionMeta } from "../../contracts/session.js";
import { PersistenceError, SessionAccessError } from "../../contracts/session.js";
import { SessionLockAdapter } from "./SessionLockAdapter.js";
import { SessionWriterAdapter, type SessionDirectories } from "./SessionWriterAdapter.js";
import { fileErrorCode, nodeSessionFileIO, requirePrivateSessionPath, SessionIdentityCollision, type SessionFileIO } from "./sessionFileIO.js";
import { validateSessionHeader } from "./sessionSchema.js";

/** bootstrap/临时目录测试的组装项；不新增 CLI/env 覆盖项，不注入模型或业务执行器。 */
export interface SessionFileOptions {
  /** 默认 ~/.yucli；测试必须显式指定临时根，父目录须已存在。 */
  storageRoot?: string;
  /** Partial 使每个覆盖项可选，用于延迟/短写/异常；未覆盖项仍使用真实 Node 文件系统。 */
  io?: Partial<SessionFileIO>;
  /** 时间来源；一次创建时间同时用于 header 和文件名，append 每次交付取一次。 */
  now?: () => Date;
  /** 新会话身份来源，运行时要求 UUID v4；碰撞最多重新生成三次。 */
  uuid?: () => string;
  /** Pick 只暴露已有 T2 的预检/取锁能力，须组装相同根；默认使用真实 adapter，不复制锁算法。 */
  locks?: Pick<SessionLockAdapter, "preflight" | "acquire">;
}

/**
 * 管理创建中及已交付的全部文件资源；创建失败也不能遗漏未返回句柄的锁/正文。
 * 只实现 T4 创建边界，后续 store 的读恢复、列表与超时监督不在这里预设假实现。
 */
export class SessionFileAdapter {
  private readonly root: string;
  private readonly io: SessionFileIO;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly locks: Pick<SessionLockAdapter, "preflight" | "acquire">;
  private readonly resources = new Set<SessionWriterAdapter>();
  private readonly preparing = new Set<Promise<OpenedSession>>();
  private closing: Promise<void> | undefined;

  /** 保存注入依赖，构造不加载 native 或创建目录；默认时钟/UUID 在实际操作时才取值。 */
  constructor(options: SessionFileOptions = {}) {
    this.root = resolve(options.storageRoot ?? join(homedir(), ".yucli"));
    this.io = { ...nodeSessionFileIO, ...options.io };
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.locks = options.locks ?? new SessionLockAdapter({ storageRoot: this.root });
  }

  /**
   * 登记一个创建操作并返回已同步 header 的 writer/空快照；调用方之后才 append user。
   * 首次 await 前纳入 preparing；整体 close 等全部准备结束，不能提前释放申请中的锁。
   * 失败不交付半准备资源，稳定访问/存储错误原样传播；关闭开始后拒绝新创建。
   */
  create(cwd: string): Promise<OpenedSession> {
    if (this.closing) return Promise.reject(new PersistenceError("contract_violation", "create", "文件 adapter 已开始关闭。"));
    const task = this.createFile(cwd);
    this.preparing.add(task);
    // 两个分支都只移除已经 settle 的登记，保留原 Promise 给调用方观察失败。
    void task.then(() => this.preparing.delete(task), () => this.preparing.delete(task));
    return task;
  }

  /**
   * 实际创建流程：无副作用预检/cwd 复核 → 私有目录 → UUID/取锁 → wx/header/目录同步。
   * 只有身份或路径碰撞最多尝试三次；其他错误不换身份重试，也不删除遗留正文/稳定锁文件。
   */
  private async createFile(cwd: string): Promise<OpenedSession> {
    try {
      await this.locks.preflight();
      if (
        typeof cwd !== "string" || resolve(cwd) !== cwd || await this.io.realpath(cwd) !== cwd ||
        !(await this.io.lstat(cwd)).isDirectory()
      ) {
        throw new SessionAccessError("cwd_mismatch", "create", "创建目录必须已规范化为当前真实绝对路径。");
      }
      const directories = await this.ensureDirectories();
      for (let attempt = 0; attempt < 3; attempt++) {
        const meta = this.newMeta(cwd);
        let writer: SessionWriterAdapter;
        try {
          const lock = await this.locks.acquire(meta.sessionId);
          // 成功关闭才撤销资源登记，避免长期 adapter 保留已关闭会话的正文和校验状态。
          writer = new SessionWriterAdapter(this.root, meta, lock, this.io, this.now, () => { this.resources.delete(writer); });
          this.resources.add(writer);
        } catch (error) {
          // 新 UUID 正好被占用也属于新身份碰撞；其余能力/权限故障不能降级或重试。
          if (error instanceof SessionAccessError && error.code === "session_busy") continue;
          throw error;
        }
        try {
          await writer.initialize(directories);
          return {
            writer,
            snapshot: { meta: { ...meta }, recentSuccessfulTurns: [], interruptedTurnCount: 0, repair: "none" },
          };
        } catch (error) {
          // initialize 的全部 I/O 已 settle；先真正关闭正文再解锁，关闭失败则继续保留资源登记。
          await writer.close();
          if (error instanceof SessionIdentityCollision) continue;
          throw error;
        }
      }
      throw new SessionAccessError("invalid_identity", "create", "三次新会话身份或路径均发生碰撞。");
    } catch (error) {
      if (error instanceof SessionAccessError || error instanceof PersistenceError) throw error;
      throw new SessionAccessError("permission_denied", "create", "无法安全准备会话目录或新文件。");
    }
  }

  /**
   * 从注入 UUID/时钟创建内部独立身份，并复用 T3 header 校验；同一次时间同时生成文件名。
   * 非 UUID v4 或非法时钟拒绝，不计作可重试碰撞；不进行文件 I/O。
   */
  private newMeta(cwd: string): SessionMeta {
    try {
      const sessionId = this.uuid();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sessionId)) throw new Error("invalid UUID");
      const createdAt = this.now().toISOString();
      const source = `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${sessionId}.jsonl`;
      validateSessionHeader({ type: "session_meta", formatVersion: 1, sessionId, createdAt, cwd }, source);
      return { sessionId, createdAt, cwd };
    } catch {
      throw new SessionAccessError("invalid_identity", "create", "新会话身份或创建时间不合法。");
    }
  }

  /**
   * 预检后逐级创建 root/sessions；已有路径仍须当前用户私有目录，拒绝 symlink/错误类型。
   * 返回身份快照供打开后及运行中复核，不递归创建 home，不自动 chmod 已有路径。
   */
  private async ensureDirectories(): Promise<SessionDirectories> {
    const identities = [];
    for (const path of [this.root, join(this.root, "sessions")]) {
      try { await this.io.mkdir(path); }
      catch (error) { if (fileErrorCode(error) !== "EEXIST") throw error; }
      const identity = await this.io.lstat(path);
      requirePrivateSessionPath(identity, true);
      identities.push(identity);
    }
    return { root: identities[0]!, sessions: identities[1]! };
  }

  /**
   * 停止新建，等待全部 create 的底层操作 settle，再幂等关闭全部已登记 writer。
   * 单个 writer 自行先关正文再放锁；任何关闭失败都上抛且资源仍被登记，不伪装关闭成功。
   * 本边界没有 T7 的 30 秒/5 秒计时器；不会因不再等待而提前解锁。
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.preparing]);
      // 不同会话可独立收尾；writer 只在实际关闭正文且放锁成功后撤销自己的登记。
      const results = await Promise.allSettled([...this.resources].map((writer) => writer.close()));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.closing;
  }
}
