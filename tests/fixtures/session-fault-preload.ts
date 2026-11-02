/** T9 测试专用 preload：在真实 CLI 加载前注入文件 I/O，生产源码没有故障配置或假模型。 */
import type { FileHandle } from "node:fs/promises";
import type { SessionFileIO } from "../../src/adapters/session/sessionFileIO.js";

const target = process.env.YUCLI_TEST_TARGET === "built" ? "dist" : "src";
const moduleUrl = new URL(`../../${target}/adapters/session/sessionFileIO.${target === "dist" ? "js" : "ts"}`, import.meta.url);
const { nodeSessionFileIO } = await import(moduleUrl.href) as { nodeSessionFileIO: SessionFileIO };
const original = { ...nodeSessionFileIO };
const paths = new Map<FileHandle, string>();
const fault = process.env.YUCLI_TEST_FAULT;
let uncertainSync: FileHandle | undefined;

/** 报告已到达的实际边界，再永久保留 Promise；父进程用 IPC/退出事件判时序，不猜 sleep。 */
function hold(path: string, stage: string): Promise<never> {
  process.send?.({ event: "held", path, stage });
  return new Promise<never>(() => {});
}

/** 跟踪实际打开的临时正文/备份，拒绝把注入套到锁算法或任意真实用户路径。 */
nodeSessionFileIO.open = async (path, flags, mode) => {
  const handle = await original.open(path, flags, mode);
  paths.set(handle, path);
  return handle;
};

/** 对选定正文或备份做一次真实写入后控制确认，模拟短写/确认丢失/修复中断。 */
nodeSessionFileIO.write = async (handle, bytes, position) => {
  const path = paths.get(handle) ?? "";
  if (fault === "backup_hang" && path.endsWith(".bak")) {
    await original.write(handle, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), position);
    return hold(path, "backup");
  }
  if (path.endsWith(".jsonl")) {
    if (bytes.length === 1 && bytes[0] === 10 && fault?.startsWith("lf_")) {
      if (fault === "lf_before") return hold(path, "before_append_lf");
      await original.write(handle, bytes, position);
      return hold(path, "after_append_lf");
    }
    let row: { type?: string; payload?: { role?: string } } = {};
    try { row = JSON.parse(Buffer.from(bytes).toString()) as typeof row; } catch { /* LF/片段不是完整记录。 */ }
    if (row.type === "message" && row.payload?.role === "user") {
      if (fault?.startsWith("write_")) {
        const written = await original.write(handle, bytes.subarray(0, Math.floor(bytes.length / 2)), position);
        if (fault === "write_hang") return hold(path, "user_write");
        // 父测试先观察真实 30 秒超时和仍持锁，再用 IPC 确认迟到完成；不靠固定 sleep。
        return new Promise<number>((resolve, reject) => {
          process.once("message", () => {
            process.send?.({ event: "late_settled", path });
            if (fault === "write_late_reject") reject(new Error("PRIVATE late I/O rejection"));
            else resolve(written);
          });
          process.send?.({ event: "held", path, stage: "late_user_write" });
        });
      }
      if (fault === "sync_reject") uncertainSync = handle;
    }
  }
  return original.write(handle, bytes, position);
};

/** 修改正文前/后停在真实 truncate 边界；父进程 SIGKILL 后下一 CLI 必须重扫实际字节。 */
nodeSessionFileIO.truncate = async (handle, size) => {
  const path = paths.get(handle) ?? "";
  if (fault === "truncate_before") return hold(path, "before_truncate");
  await original.truncate(handle, size);
  if (fault === "truncate_after") return hold(path, "after_truncate");
};

/** sync 确实执行后丢失确认；业务不得因此请求模型、重写同一序号或把它归为取消。 */
nodeSessionFileIO.sync = async (handle) => {
  await original.sync(handle);
  if (handle === uncertainSync) {
    uncertainSync = undefined;
    process.send?.({ event: "sync_rejected", path: paths.get(handle) });
    throw new Error("PRIVATE filesystem confirmation lost");
  }
};

/** 正文关闭拒绝保留真实 fd，只有进程应急退出才能释放；不伪装已经关掉。 */
nodeSessionFileIO.close = async (handle) => {
  if (fault === "close_reject" && paths.get(handle)?.endsWith(".jsonl")) {
    process.send?.({ event: "held", path: paths.get(handle), stage: "body_close" });
    throw new Error("PRIVATE close failure");
  }
  await original.close(handle);
  paths.delete(handle);
};
