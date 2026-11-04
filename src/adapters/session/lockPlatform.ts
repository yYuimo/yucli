/** adapters 层的持久化能力预检；全程只读，不创建目录、锁或探针文件。 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
import { SessionAccessError } from "../../contracts/session-lock.js";

/** native 所需的最小形状；验证后适配 callback 到 Promise，不引入额外 @types 依赖。 */
export interface NativeFlock {
  /** fs-ext 的非阻塞 flock；fd 必须由锁适配器持有，callback 完成前不得关闭或复用。 */
  flock(fd: number, operation: "exnb" | "shnb", callback: (error: NodeJS.ErrnoException | null) => void): void;
}

/** 预检输入，由适配器默认采集真实进程；测试可覆盖以验证拒绝分支，不是 CLI 配置。 */
export interface LockPlatformOptions {
  /** 三项必须与已确认环境精确一致，不能仅凭 Node 主版本授权。 */
  runtime?: { platform: string; arch: string; node: string };

  /** 按需加载入口，可注入加载失败；默认 createRequire，不在 import 时加载原生模块。 */
  loadNative?: () => unknown;

  /** 只读的 macOS mount 输出，可注入远程/未知挂载；失败或无法确认 local 均拒绝。 */
  readMounts?: () => Promise<string>;
}

const exec = promisify(execFile);

/**
 * 只在持久化能力检查时加载 fs-ext，返回值仍为 unknown，由 preflightLock 校验导出。
 * 模块缺失/ABI 不匹配会抛出，调用方转成 lock_unavailable；不会换用 mkdir 或其他锁。
 */
function loadNative(): unknown {
  return createRequire(import.meta.url)("fs-ext") as unknown;
}

/**
 * 读取当前 macOS 挂载表，供本地文件系统检查；不依赖 shell，也不将输出展示给用户。
 * 命令失败/超时交给预检拒绝；不创建任何持久化文件。
 */
async function readMounts(): Promise<string> {
  return (await exec("/sbin/mount", [], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
}

/**
 * 找到存储根最近的已存在祖先并解析其真实路径，允许尚未创建 .yucli 时先做只读检查。
 * 仅 ENOENT 向上寻找，权限/类型错误向外传播；绝不通过 mkdir 探测目录。
 */
async function existingAncestor(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
    return existingAncestor(dirname(path));
  }
}

/**
 * 判断路径是否位于显式标记 local 的最长匹配挂载点内，供预检在副作用之前调用。
 * 按路径段比较而非字符串前缀，避免 /work 与 /workspace 碰撞；远程或无法解析时拒绝。
 * 这是 macOS mount 输出的保守检查，不宣称识别所有共享/用户态挂载或对抗挂载变化。
 */
async function requireLocalFilesystem(path: string, mounts: string): Promise<void> {
  const target = await existingAncestor(path);
  let match: { length: number; local: boolean } | undefined;
  for (const line of mounts.split("\n")) {
    // / 后允许零个字符以包含根挂载点；只读取挂载路径和 flags，不凭设备名前缀猜 local。
    const parsed = /^.+ on (\/.*) \(([^)]+)\)$/u.exec(line);
    if (!parsed) continue;
    const mountpoint = parsed[1]!;
    const parts = relative(mountpoint, target);
    if (isAbsolute(parts) || parts.split(sep)[0] === "..") continue;
    if (!match || mountpoint.length >= match.length) {
      match = { length: mountpoint.length, local: parsed[2]!.split(", ").includes("local") };
    }
  }
  if (!match?.local) throw new SessionAccessError("platform_unsupported", "preflight", "持久化只支持可确认的本地文件系统。");
}

/**
 * 在任何 mkdir/open-create 前检查精确平台、native 加载与本地文件系统，供写锁/探测调用。
 * root 为受管存储根；options 只用于能力注入。成功返回已校验的 flock 模块，不取得锁。
 * 平台/文件系统无法确认抛 platform_unsupported；加载/导出错误抛 lock_unavailable。
 * 全程不落盘；不支持平台不尝试加载原生模块，不创建探针锁，也不降级。
 */
export async function preflightLock(root: string, options: LockPlatformOptions = {}): Promise<NativeFlock> {
  const runtime = options.runtime ?? { platform: process.platform, arch: process.arch, node: process.versions.node };
  if (runtime.platform !== "darwin" || runtime.arch !== "arm64" || runtime.node !== "24.14.0") {
    throw new SessionAccessError("platform_unsupported", "preflight", "持久化只支持 macOS arm64 与 Node 24.14.0。");
  }

  // native 是 optionalDependency，但写路径不能把加载失败当成功；先检查，再允许后继创建目录。
  let native: unknown;
  try {
    native = (options.loadNative ?? loadNative)();
    if (typeof native !== "object" || native === null || !("flock" in native) || typeof native.flock !== "function") {
      throw new Error("invalid native export");
    }
  } catch {
    throw new SessionAccessError("lock_unavailable", "preflight", "原生锁不可用，请检查 fs-ext 的目标平台构建。");
  }

  try {
    await requireLocalFilesystem(root, await (options.readMounts ?? readMounts)());
  } catch {
    throw new SessionAccessError("platform_unsupported", "preflight", "无法确认持久化路径位于支持的本地文件系统。");
  }
  return native as NativeFlock;
}
