import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { AbortError } from "../../contracts/llm-client.js";
import type { Tool, ToolDefinition } from "../../contracts/tool.js";

const MAX_BYTES = 64 * 1024;

/** 返回固定、安全的工具失败文本；不把路径或底层异常插入发送给模型的结果。 */
function failure(code: string, message: string): { ok: false; content: string } {
  return { ok: false, content: `[${code}] ${message}` };
}

/**
 * 按根目录到目标的相对路径段判断包含关系，供词法路径和真实路径检查共用。
 * 返回 false 表示逃到根外；不采用 startsWith，避免 /work 与 /workspace 前缀碰撞。
 */
function isWithin(root: string, target: string): boolean {
  const parts = relative(root, target);
  return !isAbsolute(parts) && parts.split(sep)[0] !== "..";
}

/** 固定的只读文件工具；工作区根目录由 bootstrap 注入，不允许模型指定根。 */
export class ReadFileTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "read_file",
    description: "读取工作区内的 UTF-8 文本文件，不会修改文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对于工作区根目录的文件路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  };

  /** 保存工作区位置；不会在构造时读文件，execute 才解析真实路径。 */
  constructor(private readonly workspaceRoot: string) {}

  /**
   * 校验路径并读取工作区内最多 64 KiB 的有效 UTF-8 普通文件，返回完整原文。
   * 注册表传入解析后的 {path}；空文件成功，路径/权限/类型/大小/编码错误返回 ok:false。
   * stat 在读取前执行，真实路径检查防止符号链接逃逸；读取后再次检查大小。
   * signal 取消时抛 AbortError；文件句柄在 finally 关闭，不返回绝对路径或异常栈。
   */
  async execute(args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; content: string }> {
    if (signal?.aborted) throw new AbortError("文件读取已取消。");

    if (
      typeof args !== "object" || args === null || Array.isArray(args) ||
      Object.keys(args).length !== 1 || !("path" in args) || typeof args.path !== "string"
    ) {
      return failure("invalid_arguments", "参数必须恰好包含字符串 path。");
    }

    const input = args.path;
    if (!input.trim() || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) {
      return failure("invalid_path", "只允许非空的工作区相对路径。");
    }

    const root = resolve(this.workspaceRoot);
    const target = resolve(root, input);
    if (!isWithin(root, target)) return failure("outside_workspace", "文件路径超出工作区。");

    try {
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      if (signal?.aborted) throw new AbortError("文件读取已取消。");

      if (!isWithin(realRoot, realTarget)) {
        return failure("outside_workspace", "符号链接目标超出工作区。");
      }

      const info = await stat(realTarget);
      if (!info.isFile()) return failure("not_regular_file", "目标不是普通文件。");
      if (info.size > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");
      if (signal?.aborted) throw new AbortError("文件读取已取消。");

      // 不跟随打开时被替换的末端符号链接；再检查实际打开的句柄，缩小检查/读取间的竞态。
      const handle = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) return failure("not_regular_file", "目标不是普通文件。");
        if (opened.size > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");

        // 最多分配上限 + 1 字节，即使文件在 stat 后增长也不会无界读取或静默截断。
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let used = 0;
        while (used < buffer.length) {
          if (signal?.aborted) throw new AbortError("文件读取已取消。");

          const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
          if (!bytesRead) break;
          used += bytesRead;
        }

        if (signal?.aborted) throw new AbortError("文件读取已取消。");
        if (used > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");

        try {
          return { ok: true, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used)) };
        } catch {
          return failure("invalid_utf8", "文件不是有效 UTF-8 文本。");
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (signal?.aborted || error instanceof AbortError) throw new AbortError("文件读取已取消。");

      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") return failure("file_not_found", "文件不存在。");
      if (code === "EACCES" || code === "EPERM") return failure("permission_denied", "没有读取文件的权限。");
      return failure("read_failed", "无法读取文件。");
    }
  }
}
