/** adapters 层持锁尾部修复；由已有文件 writer 调用，只备份/改尾/重验，不执行历史事实。 */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { PersistenceError } from "../../contracts/session.js";
import type { SessionSnapshot } from "../../contracts/session.js";
import { scanSessionHandle } from "./scanSession.js";
import type { ValidScanResult } from "./scanTypes.js";
import {
  fileErrorCode, requirePrivateSessionPath, sameSessionIdentity, writeSessionBytes, type SessionFileIO,
} from "./sessionFileIO.js";

/** writer 交付的内部修复能力；全部 fd 仍归 writer 登记，修复器不能自行放锁。 */
export interface SessionRepairContext {
  /** 已复核的受管根，recovery 仅能创建在它下面。 */
  root: string;
  /** 同一次 r+ 打开的正文句柄，不重开正文、不使用 a+/w。 */
  body: FileHandle;
  /** 打开/扫描前的身份与时间观测，修改前必须保持一致。 */
  original: BigIntStats;
  /** 默认真实 Node 的可注入读取、写入、同步及截断能力。 */
  io: SessionFileIO;
  /** 备份和清单共用一次新时钟/UUID 取值；不复用会话的创建时间。 */
  now: () => Date;
  uuid: () => string;
  /** 打开临时 fd 后立即登记到 writer；失败未返回 writer 时也不能泄漏资源。 */
  own(handle: FileHandle): void;
  /** 等真实关闭完成；关闭失败保留 fd/锁并抛 close_failed，不重试。 */
  close(handle: FileHandle): Promise<void>;
  /** 复核锁、root/sessions、正文路径/fd 与明确大小；不改变追加游标。 */
  assertSource(sizeBytes: number): Promise<void>;
}

/** 修复成功的唯一返回值；扫描实际文件得到的完整结果才能用来初始化续写。 */
export interface RepairedSession {
  /** 重扫后的健康文件，tailKind 必须 none，不能返回旧只读边界作为写许可。 */
  scan: ValidScanResult;
  /** 本次实际动作；完整文件由调用方直接处理，不会进入本组件。 */
  repair: Exclude<SessionSnapshot["repair"], "none">;
}

/**
 * 按块遍历恰好 [0,size)；摘要、复制及最终复核共用，不把正文一次载入内存。
 * consume 在本块读完后被等待，故复制的写入结束前不会复用 buffer；短读允许，零进度拒绝。
 * 底层错误直接交给 repair 边界分类，既不扩大 S，也不猜测 EOF 后的数据。
 */
async function visitRange(
  context: SessionRepairContext,
  handle: FileHandle,
  size: number,
  consume: (bytes: Uint8Array, position: number) => Promise<void> | void,
): Promise<void> {
  let position = 0;
  while (position < size) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, size - position));
    const count = await context.io.read(handle, buffer, position);
    if (!Number.isSafeInteger(count) || count <= 0 || count > buffer.length) throw new Error("source range not readable");
    await consume(buffer.subarray(0, count), position);
    position += count;
  }
}

/** 为原件/备份/修复后文件计算指定字节范围 SHA-256；没有解析或重新序列化正文的副作用。 */
async function digestRange(context: SessionRepairContext, handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  // 每个实际读到的字节直接进入摘要，字符串 length 或 Unicode 码点数不参与计算。
  await visitRange(context, handle, size, (bytes) => { hash.update(bytes); });
  return hash.digest("hex");
}

/**
 * 为备份/修改屏障复核原 inode、大小、mtime/ctime 和受管路径；不改正文，变化即抛错交给 repair_failed 边界。
 * 时间证据只是保守检查，不能替代后续的完整 SHA-256 复核。
 */
async function assertOriginal(context: SessionRepairContext, size: number): Promise<void> {
  await context.assertSource(size);
  const current = await context.body.stat({ bigint: true });
  if (
    !sameSessionIdentity(current, context.original) || current.size !== BigInt(size) ||
    current.mtimeNs !== context.original.mtimeNs || current.ctimeNs !== context.original.ctimeNs
  ) throw new Error("source changed before repair");
}

/**
 * 仅修复扫描器证明合法的 missing_lf/incomplete；writer 持锁、已核对 cwd 后调用。
 * 先完整原件摘要/备份/清单/目录同步，再再次复核原件，才对同一 fd 补 LF 或截断并重扫。
 * 修改前失败不改正文；修改后失败保留实际字节/备份，不回滚、不删除、不重复应用旧边界。
 * 仅全部成功交付新扫描；普通修复失败为 repair_failed，关闭失败仍是 close_failed。
 */
export async function repairSessionTail(context: SessionRepairContext, initial: ValidScanResult): Promise<RepairedSession> {
  const size = initial.observedSizeBytes;
  const validEnd = initial.validEndBytes;
  const action = initial.tailKind === "missing_lf" ? "append_lf" : "truncate_tail";
  try {
    if (initial.tailKind === "none" || initial.changing) throw new Error("not a repairable fixed source");
    await assertOriginal(context, size);
    const sourceSha256 = await digestRange(context, context.body, size);
    await assertOriginal(context, size);

    // recovery 的两级容器都拒绝符号链接/宽权限；已有目录也逐级检查，不自动 chmod。
    const recovery = join(context.root, "recovery");
    const sessionRecovery = join(recovery, initial.meta.sessionId);
    const directories = new Map<string, BigIntStats>();
    for (const path of [recovery, sessionRecovery]) {
      await context.assertSource(size);
      try { await context.io.mkdir(path); }
      catch (error) { if (fileErrorCode(error) !== "EEXIST") throw error; }
      const identity = await context.io.lstat(path);
      requirePrivateSessionPath(identity, true);
      directories.set(path, identity);
    }

    /** 在创建/同步备份路径及修改正文前复核容器；变化抛错停止修复，不修改目录或正文。 */
    async function assertRecovery(): Promise<void> {
      for (const [path, original] of directories) {
        const current = await context.io.lstat(path);
        requirePrivateSessionPath(current, true);
        if (!sameSessionIdentity(original, current)) throw new Error("recovery directory changed");
      }
    }

    const createdAt = context.now().toISOString();
    const uuid = context.uuid();
    if (createdAt.length !== 24 || typeof uuid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(uuid)) {
      throw new Error("invalid recovery identity");
    }
    const prefix = `${createdAt.replaceAll(":", "-").replaceAll(".", "-")}_${uuid}`;

    /** wx 创建一份空的私有产物并立即登记 fd；碰撞/错误均失败，不重新取身份或覆盖旧备份。 */
    async function artifact(suffix: string): Promise<{ handle: FileHandle; path: string; identity: BigIntStats }> {
      await context.assertSource(size);
      await assertRecovery();
      const path = join(sessionRecovery, `${prefix}${suffix}`);
      const handle = await context.io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      context.own(handle);
      const identity = await handle.stat({ bigint: true });
      requirePrivateSessionPath(identity, false);
      const entry = await context.io.lstat(path);
      requirePrivateSessionPath(entry, false);
      if (!sameSessionIdentity(entry, identity) || identity.size !== 0n) throw new Error("artifact is not new");
      return { handle, path, identity };
    }

    /**
     * 同步后检查产物路径/fd、权限和实际字节数，变化即拒绝修复，不把 write 回调当复制完整。
     * Awaited/ReturnType 只提取 artifact Promise 的结果类型，不代替下面的运行时检查。
     */
    async function assertArtifact(item: Awaited<ReturnType<typeof artifact>>, expectedSize: number): Promise<void> {
      const entry = await context.io.lstat(item.path);
      const descriptor = await item.handle.stat({ bigint: true });
      requirePrivateSessionPath(entry, false);
      requirePrivateSessionPath(descriptor, false);
      if (!sameSessionIdentity(entry, item.identity) || !sameSessionIdentity(descriptor, item.identity) || descriptor.size !== BigInt(expectedSize)) {
        throw new Error("artifact changed");
      }
    }

    const backup = await artifact(".jsonl.bak");
    const copied = createHash("sha256");
    const kept = createHash("sha256");
    // 备份逐字节包含残片；另对将保留的前缀累计摘要，供修改后的实际文件复核。
    await visitRange(context, context.body, size, async (bytes, position) => {
      copied.update(bytes);
      if (position < validEnd) kept.update(bytes.subarray(0, Math.min(bytes.length, validEnd - position)));
      await writeSessionBytes(context.io, backup.handle, bytes, position);
    });
    const expectedRepairedSha = action === "append_lf" ? copied.copy().update("\n").digest("hex") : kept.digest("hex");
    if (copied.digest("hex") !== sourceSha256) throw new Error("source changed during copy");
    await context.io.sync(backup.handle);
    await assertArtifact(backup, size);
    if (await digestRange(context, backup.handle, size) !== sourceSha256) throw new Error("backup digest mismatch");

    const manifest = await artifact(".repair.json");
    const manifestBytes = Buffer.from(JSON.stringify({
      version: 1, sessionId: initial.meta.sessionId, sourceBasename: initial.sourceBasename, createdAt, action,
      originalSizeBytes: size, validEndBytes: validEnd, lastSeq: initial.lastSeq, sourceSha256,
    }) + "\n");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    await writeSessionBytes(context.io, manifest.handle, manifestBytes, 0);
    await context.io.sync(manifest.handle);
    await assertArtifact(manifest, manifestBytes.length);
    if (await digestRange(context, manifest.handle, manifestBytes.length) !== manifestSha256) {
      throw new Error("manifest digest mismatch");
    }

    // 同步每一级新目录项，根本身已存在；所有临时 close 也在正文修改之前实际完成。
    for (const path of [sessionRecovery, recovery, context.root]) {
      await assertRecovery();
      await context.assertSource(size);
      const handle = await context.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      context.own(handle);
      const descriptor = await handle.stat({ bigint: true });
      const entry = await context.io.lstat(path);
      requirePrivateSessionPath(descriptor, true);
      requirePrivateSessionPath(entry, true);
      if (!sameSessionIdentity(descriptor, entry)) throw new Error("directory changed during sync");
      await context.io.sync(handle);
      await context.close(handle);
    }

    await assertRecovery();
    await assertArtifact(backup, size);
    await assertArtifact(manifest, manifestBytes.length);
    if (
      await digestRange(context, backup.handle, size) !== sourceSha256 ||
      await digestRange(context, manifest.handle, manifestBytes.length) !== manifestSha256
    ) throw new Error("recovery evidence changed before mutation");
    await context.close(backup.handle);
    await context.close(manifest.handle);

    // 最后一道修改前屏障：再次确认原 inode、大小和全部 [0,S) 的 SHA-256。
    // 外部修改无法用回滚消除，这些检查依赖写者遵守 advisory 锁协议。
    await assertOriginal(context, size);
    if (await digestRange(context, context.body, size) !== sourceSha256) throw new Error("source digest changed before mutation");
    await assertOriginal(context, size);
    const repairedSize = action === "append_lf" ? size + 1 : validEnd;
    if (action === "append_lf") await writeSessionBytes(context.io, context.body, Buffer.from("\n"), size);
    else await context.io.truncate(context.body, validEnd);
    await context.io.sync(context.body);
    await context.assertSource(repairedSize);

    // 不复用旧扫描结果：以同一 fd 重扫实际文件，再用预期前缀摘要确认没有改写旧 JSON。
    const afterMutation = await context.body.stat({ bigint: true });
    const scan = await scanSessionHandle(context.body, initial.sourceBasename);
    if (
      scan.status !== "valid" || scan.changing || scan.tailKind !== "none" || scan.lastSeq !== initial.lastSeq ||
      scan.validEndBytes !== repairedSize || scan.lastLfEndBytes !== repairedSize || scan.observedSizeBytes !== repairedSize ||
      scan.dev !== initial.dev || scan.ino !== initial.ino ||
      scan.meta.cwd !== initial.meta.cwd || scan.meta.sessionId !== initial.meta.sessionId || scan.meta.createdAt !== initial.meta.createdAt
    ) throw new Error("repaired file rejected");
    if (await digestRange(context, context.body, repairedSize) !== expectedRepairedSha) throw new Error("repaired prefix differs");
    await context.assertSource(repairedSize);
    const final = await context.body.stat({ bigint: true });
    if (afterMutation.mtimeNs !== final.mtimeNs || afterMutation.ctimeNs !== final.ctimeNs) throw new Error("repaired source changed");
    return { scan, repair: action };
  } catch (error) {
    // 关闭不确定时不能伪装成普通修复失败或释放锁；未来监督层的超时分类也不能被吞掉。
    if (error instanceof PersistenceError && (error.code === "close_failed" || error.code === "io_timeout")) throw error;
    throw new PersistenceError("repair_failed", "repair", "会话尾部修复未取得完整确认。", { seq: initial.lastSeq, byteOffset: validEnd });
  }
}
