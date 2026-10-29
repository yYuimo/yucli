/** adapters 层的正文 I/O 注入边界；T4 的创建和 writer 使用，锁仍由 T2 自行管理。 */
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { SessionAccessError } from "../../contracts/session.js";

/**
 * 文件创建/写入实际使用的窄能力；默认委托 Node，测试可逐项替换以控制 settle/短写/故障。
 * 保留真实 FileHandle，便于用 T3 scanSessionHandle 验证；不提供 repair/truncate 能力。
 */
export interface SessionFileIO {
  /** 读取路径自身的 bigint 身份，不能跟随受管末端符号链接；失败由调用方分类。 */
  lstat(path: string): Promise<BigIntStats>;
  /** 仅创建单级 0700 目录；已有路径仍须另行 lstat 校验，不自动 chmod。 */
  mkdir(path: string): Promise<void>;
  /** 按调用方明确的 flags/mode 打开；创建正文须 EXCL，目录须 NOFOLLOW。 */
  open(path: string, flags: number, mode?: number): Promise<FileHandle>;
  /** 列出扁平 sessions 名称供新身份碰撞检查；不解析正文、不实现列表产品入口。 */
  readdir(path: string): Promise<string[]>;
  /** 解析调用方 cwd；创建要求其已经是 realpath，不默默改变归属。 */
  realpath(path: string): Promise<string>;
  /** 从指定字节位置写出整个 remaining 的一个片段；返回实际写入量，允许短写。 */
  write(handle: FileHandle, remaining: Uint8Array, position: number): Promise<number>;
  /** 等待 Node FileHandle.sync；成功才构成该文件/目录的同步证据。 */
  sync(handle: FileHandle): Promise<void>;
  /** 等待真正的 close；失败不能被解释为句柄已经安全关闭。 */
  close(handle: FileHandle): Promise<void>;
}

/** 默认系统实现；箭头仅适配参数，不创建缓存、后台写入或替代锁。 */
export const nodeSessionFileIO: SessionFileIO = {
  lstat: (path) => lstat(path, { bigint: true }),
  mkdir: async (path) => { await mkdir(path, { mode: 0o700 }); },
  open: (path, flags, mode) => open(path, flags, mode),
  readdir: (path) => readdir(path),
  realpath: (path) => realpath(path),
  write: async (handle, remaining, position) => (await handle.write(remaining, 0, remaining.length, position)).bytesWritten,
  sync: (handle) => handle.sync(),
  close: (handle) => handle.close(),
};

/** 从底层异常中只读取机器码；路径、正文、stack 不进入公开错误。 */
export function fileErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * 拒绝非当前用户、组/其他用户可访问、错误类型和多硬链接正文；创建前后及运行中共用。
 * 输入来自 lstat/fstat；不修改权限，不把符号链接当目录/文件，失败为访问拒绝。
 */
export function requirePrivateSessionPath(stats: BigIntStats, directory: boolean): void {
  if (
    stats.uid !== BigInt(process.getuid!()) || (stats.mode & 0o077n) !== 0n ||
    (directory ? !stats.isDirectory() : !stats.isFile() || stats.nlink !== 1n)
  ) throw new SessionAccessError("permission_denied", "session_path", "会话路径的类型、所有者或权限不符合要求。");
}

/** 比较精确 dev/ino；大小另由 writer 检查，不依赖 mtime 或日志内容判断身份。 */
export function sameSessionIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

/** 只用于生成新身份时的碰撞控制流；不能吞掉其他创建/同步/关闭故障并重试。 */
export class SessionIdentityCollision extends Error {}
