import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { AbortError } from "../../contracts/llm-client.js";
import type { Tool, ToolDefinition } from "../../contracts/tool.js";

const MAX_BYTES = 64 * 1024;

/**
 * 将文件操作失败整理成普通工具结果，让模型看到错误后仍能继续回答。
 * ReadFileTool.execute 各校验/读取失败分支调用它；它不抛出错误。
 *
 * @param code 稳定错误分类，例如 file_not_found，供测试和模型识别原因。
 * @param message 调用点提供的固定说明，不能包含绝对路径、密钥或原始异常。
 * @returns {ok:false, content:"[分类] 说明"}；调用 ID 和名称由注册表随后补上。
 * 本函数只组合字符串，不读取文件或记录日志，也不会替调用方自动脱敏任意输入。
 */
function failure(code: string, message: string): { ok: false; content: string } {
  return { ok: false, content: `[${code}] ${message}` };
}

/**
 * 判断目标路径是否等于工作区根，或处于根目录内部，用于拒绝越界读取。
 * execute 在 resolve 后检查一次词法路径，在 realpath 后再检查实际目标位置。
 *
 * @param root 已解析的工作区根路径。
 * @param target 与 root 使用同种解析方式得到的目标绝对路径。
 * @returns 根内或等于根时为 true；跨盘或相对路径首段为 .. 时为 false。
 * 例如 /work/a 在 /work 内，而 /workspace/a 不在；相同字符串前缀不代表包含关系。
 * 这是纯路径比较，不访问磁盘、不解析符号链接，也不判断目标是否为文件。
 */
function isWithin(root: string, target: string): boolean {
  // relative 得到从根到目标的路径；越界会以独立的 .. 路径段开头，跨盘可能仍是绝对路径。
  // 按路径段判断而非 startsWith(root)，避免 /work 与 /workspace 的同前缀碰撞。
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

  /**
   * 创建绑定到指定工作区的只读工具，限制之后各次调用可读取的根目录。
   * bootstrap 用启动时的 process.cwd() 创建它，再注册到 RegisteredTools。
   *
   * @param workspaceRoot 工作区目录位置，由应用提供，模型不能在参数中改写。
   * 构造器只保存路径并得到工具实例；execute 才解析真实路径并报告目录/文件错误。
   * 不在此处检查目录是否存在，不读取文件，也不创建文件句柄。
   */
  constructor(private readonly workspaceRoot: string) {}

  /**
   * 读取工作区内一个最多 64 KiB 的 UTF-8 普通文件，把原文交给模型使用。
   * 注册表完成参数解析后调用；这里复核对象结构，再处理文件系统相关的失败。
   * 步骤：检查相对路径 → 检查真实路径是否越界 → stat 检查类型/大小 → 打开并有界读取 → 解码。
   *
   * @param args 待复核的参数对象，必须恰好包含字符串 path；不是参数 JSON 字符串。
   * @param signal 与循环共用的可选取消信号，在文件操作前后及每次读取前检查。
   * @returns Promise<{ok,content}>；成功为完整原文，空文件也成功，保留换行及开头 BOM。
   * 路径、文件类型、大小、权限和编码错误返回 ok:false 与固定安全摘要，不回传底层异常。
   * @throws AbortError 取消时拒绝 Promise，不再把文件内容作为成功结果返回。
   * 文件只读不写；句柄在 finally 关闭。最多读取 65537 字节，以发现检查后增长的文件。
   * 路径检查不等于 OS 沙箱，不承诺对父目录并发替换提供原子隔离或抢占底层文件操作。
   */
  async execute(args: unknown, signal?: AbortSignal): Promise<{ ok: boolean; content: string }> {
    if (signal?.aborted) throw new AbortError("文件读取已取消。");

    // 1. 参数虽然通常已由注册表校验，但工具可以被独立调用，所以仍守住自己的输入边界。
    // 这里只接受 {path:string}，不接受模型指定编码、根目录或其他额外配置。
    if (
      typeof args !== "object" || args === null || Array.isArray(args) ||
      Object.keys(args).length !== 1 || !("path" in args) || typeof args.path !== "string"
    ) {
      return failure("invalid_arguments", "参数必须恰好包含字符串 path。");
    }

    // 2. 同时拒绝当前平台和 Windows 格式的绝对路径，避免换个平台就改变输入含义。
    // trim 只判断空白，不修改路径；NUL 不能交给底层文件 API。
    const input = args.path;
    if (!input.trim() || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) {
      return failure("invalid_path", "只允许非空的工作区相对路径。");
    }

    // 3. resolve 规范化 .. 等词法路径，再检查是否位于工作区内；此时尚未解析符号链接。
    const root = resolve(this.workspaceRoot);
    const target = resolve(root, input);
    if (!isWithin(root, target)) return failure("outside_workspace", "文件路径超出工作区。");

    try {
      // 4. 根和目标都解析真实路径，防止工作区内的链接实际指向区外。
      // await 不代表文件操作支持即时取消，完成后仍要重新检查 turn 的取消信号。
      const realRoot = await realpath(root);
      const realTarget = await realpath(target);
      if (signal?.aborted) throw new AbortError("文件读取已取消。");

      if (!isWithin(realRoot, realTarget)) {
        return failure("outside_workspace", "符号链接目标超出工作区。");
      }

      // 5. 先 stat 再读，提前拒绝目录/特殊文件和已超限文件，避免无意义的打开与读取。
      const info = await stat(realTarget);
      if (!info.isFile()) return failure("not_regular_file", "目标不是普通文件。");
      if (info.size > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");
      if (signal?.aborted) throw new AbortError("文件读取已取消。");

      // 不跟随打开时被替换的末端符号链接；再检查实际打开的句柄，缩小检查/读取间的竞态。
      const handle = await open(realTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        // 路径 stat 与 open 之间文件可能被替换，因此复核实际打开的句柄。
        // O_NONBLOCK 避免某些特殊文件打开时阻塞；是否普通文件仍以这个检查为准。
        const opened = await handle.stat();
        if (!opened.isFile()) return failure("not_regular_file", "目标不是普通文件。");
        if (opened.size > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");

        // 最多分配上限 + 1 字节，即使文件在 stat 后增长也不会无界读取或静默截断。
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let used = 0;
        while (used < buffer.length) {
          if (signal?.aborted) throw new AbortError("文件读取已取消。");

          // 一次 read 不保证填满缓冲区：从 used 位置继续写，最多读剩余容量。
          // 最后的 null 使用句柄当前文件位置；bytesRead=0 才说明已到 EOF。
          const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
          if (!bytesRead) break;
          used += bytesRead;
        }

        // 6. 读取后的检查捕捉 stat 后增长的文件；多读的第 65537 字节只用于发现超限，
        // 不能把前 65536 字节静默截断后作为成功结果交给模型。
        if (signal?.aborted) throw new AbortError("文件读取已取消。");
        if (used > MAX_BYTES) return failure("file_too_large", "文件超过 64 KiB 上限。");

        try {
          // 7. 只解码真正读到的字节，不能把未使用的缓冲区尾部零值当作文件内容。
          // fatal 拒绝坏 UTF-8；ignoreBOM:true 将 BOM 作为原文保留，不悄悄删去文件字符。
          return { ok: true, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used)) };
        } catch {
          return failure("invalid_utf8", "文件不是有效 UTF-8 文本。");
        }
      } finally {
        // 内层任何 return/throw 都会关闭句柄，包括超限、编码错误和取消路径。
        await handle.close();
      }
    } catch (error) {
      // 8. 取消是整个 turn 的停止原因，继续抛出；其他常见文件错误变成可恢复工具结果。
      if (signal?.aborted || error instanceof AbortError) throw new AbortError("文件读取已取消。");

      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

      // 只读取稳定错误码决定分类，不拼接底层 error.message，避免把绝对路径等信息回传模型。
      if (code === "ENOENT" || code === "ENOTDIR") return failure("file_not_found", "文件不存在。");
      if (code === "EACCES" || code === "EPERM") return failure("permission_denied", "没有读取文件的权限。");
      return failure("read_failed", "无法读取文件。");
    }
  }
}
