/** adapters 层只读列表：header 过滤后复用 T3 扫描与 T2 probe，不创建/修复正文或 sidecar。 */
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SessionList, SessionListDiagnostic, SessionMeta } from "../../contracts/session.js";
import { PersistenceError, SessionAccessError } from "../../contracts/session.js";
import type { SessionFileIO } from "./sessionFileIO.js";
import { fileErrorCode, requirePrivateSessionPath, sameSessionIdentity } from "./sessionFileIO.js";
import { parseSessionBasename } from "./sessionFilename.js";
import { validateSessionHeader } from "./sessionSchema.js";
import { scanSessionHandle } from "./scanSession.js";

/** 文件 adapter 管理描述符和期限，本组件只借用所需能力；关闭失败不能被降级成单文件诊断。 */
export interface SessionListContext {
  /** 已组装的受管根与 guarded I/O，不是用户任意文件路径。 */
  root: string;
  io: SessionFileIO;
  /** 当前观察时间来源，使用日志同一 ISO 展示时钟。 */
  now: () => Date;
  /** T2 只读占用探测；不调用 acquire。 */
  probe(id: string): Promise<"busy" | "available" | "unknown">;
  /** 描述符从打开成功即登记，关闭须真实 settle，超时后不能遗失。 */
  own(handle: FileHandle): void;
  close(handle: FileHandle): Promise<void>;
  /** 异步观察之后、probe 等独立副作用边界之前检查总期限。 */
  assertActive(): void;
}

/** 只读取首行并复用 T3 header 校验；不扫描其他 cwd 的消息，失败交给完整扫描生成诊断。 */
async function readMeta(context: SessionListContext, handle: FileHandle, basename: string, size: number): Promise<SessionMeta | undefined> {
  const parts: Buffer[] = [];
  let position = 0;
  while (position < size) {
    const buffer = Buffer.alloc(Math.min(4096, size - position));
    const count = await context.io.read(handle, buffer, position);
    if (count <= 0 || count > buffer.length) throw new Error("invalid header read");
    const bytes = buffer.subarray(0, count); const lf = bytes.indexOf(10);
    parts.push(lf < 0 ? bytes : bytes.subarray(0, lf));
    position += count;
    if (lf >= 0) break;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
    const header = validateSessionHeader(JSON.parse(text) as unknown, basename);
    return { sessionId: header.sessionId, cwd: header.cwd, createdAt: header.createdAt };
  } catch { return undefined; }
}

/** 比较合法 UTC ISO 时间，补齐小数部分再按字典序比较，避免无小数秒或长精度被 Date 截断。 */
function compareTime(left: string, right: string): number {
  const first = left.slice(0, 19); const second = right.slice(0, 19);
  if (first !== second) return first < second ? -1 : 1;
  const a = left[19] === "." ? left.slice(20, -1) : "";
  const b = right[19] === "." ? right.slice(20, -1) : "";
  const length = Math.max(a.length, b.length); const paddedA = a.padEnd(length, "0"); const paddedB = b.padEnd(length, "0");
  return paddedA === paddedB ? 0 : paddedA < paddedB ? -1 : 1;
}

/**
 * 创建 current/all 列表快照；由文件 adapter 的 30 秒公开等待包裹并登记实际任务。
 * cwd 必须真实规范，缺根/容器返回空；坏文件单独诊断，目录级失败为 PersistenceError。
 * 每次仅持有一个扫描 fd，先 header 过滤再复用 T3；finally 等真实关闭，不写入任何文件。
 */
export async function listSessions(context: SessionListContext, input: { cwd: string; all: boolean }): Promise<SessionList> {
  const { io, root } = context;
  const result: SessionList = { entries: [], diagnostics: [], hiddenEmptyCount: 0, unattributedCount: 0 };
  const entries = [] as SessionList["entries"][number][];
  const diagnostics: SessionListDiagnostic[] = [];
  try {
    try {
      if (resolve(input.cwd) !== input.cwd || await io.realpath(input.cwd) !== input.cwd || !(await io.lstat(input.cwd)).isDirectory()) throw new Error("invalid cwd");
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new SessionAccessError("cwd_mismatch", "list", "列表工作目录必须是真实规范绝对目录。");
    }
    const sessions = join(root, "sessions");
    const identities: BigIntStats[] = [];
    for (const path of [root, sessions]) {
      let identity: BigIntStats;
      try { identity = await io.lstat(path); }
      catch (error) { if (fileErrorCode(error) === "ENOENT") return result; throw error; }
      // 逐级验证已有容器；不能因子目录缺失就把不安全的 root 当作合法空存储。
      requirePrivateSessionPath(identity, true);
      identities.push(identity);
    }
    const names = await io.readdir(sessions);
    for (const basename of names.filter((name) => name.endsWith(".jsonl")).sort()) {
      context.assertActive();
      let handle: FileHandle | undefined; let meta: SessionMeta | undefined;
      try {
        if (!parseSessionBasename(basename)) throw new SessionAccessError("invalid_identity", "list", "正文文件名不符合受管规则。");
        // 路径与描述符身份都校验；打开成功立即登记，之后任何分支都等待真实 close。
        const path = join(sessions, basename);
        const entry = await io.lstat(path); requirePrivateSessionPath(entry, false);
        handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); context.own(handle);
        const initial = await handle.stat({ bigint: true }); requirePrivateSessionPath(initial, false);
        if (!sameSessionIdentity(initial, entry) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new SessionAccessError("invalid_identity", "list", "正文身份或大小无法安全观察。");
        // 先读 header 过滤 cwd；其他项目正文不必全扫，无法归属则交 T3 产生诊断。
        meta = await readMeta(context, handle, basename, Number(initial.size));
        if (meta && !input.all && meta.cwd !== input.cwd) continue;
        // 直接借同一只读 fd 交 T3，拒绝文件不拿部分成功历史冒充可恢复条目。
        const scan = await scanSessionHandle(handle, basename);
        if (scan.status === "rejected") {
          diagnostics.push({ sourceBasename: basename, code: scan.logState, message: scan.diagnostic.message,
            ...(meta ? { sessionId: meta.sessionId, cwd: meta.cwd } : {}),
            ...(scan.diagnostic.line === undefined ? {} : { line: scan.diagnostic.line }),
            ...(scan.diagnostic.byteOffset === undefined ? {} : { byteOffset: scan.diagnostic.byteOffset }) });
          if (!meta) result.unattributedCount++;
          continue;
        }
        if (!input.all && scan.meta.cwd !== input.cwd) continue;
        if (!input.all && scan.statistics.turnCount === 0) { result.hiddenEmptyCount++; continue; }
        context.assertActive();
        // probe 只短暂观察；随后的变化证据使 unknown/changing 只能交正式打开重验。
        const writerState = await context.probe(scan.meta.sessionId);
        const final = await io.lstat(path);
        const changing = scan.changing || initial.size !== final.size || initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs || !sameSessionIdentity(initial, final);
        const reason = scan.meta.cwd !== input.cwd ? "其他工作目录，仅可预览。" : writerState === "busy" ? "会话正被写者占用。" : changing ? "观察期间发生变化，正式打开时重验。" : writerState === "unknown" ? "无法确认锁状态，正式打开时重验。" : undefined;
        entries.push({ ...scan.meta, lastActivityAt: scan.statistics.lastActivityAt, turnCount: scan.statistics.turnCount,
          lastTurnOutcome: scan.statistics.lastTurnOutcome, preview: scan.statistics.preview, lastSeq: scan.lastSeq, writerState, logState: scan.logState,
          observedAt: context.now().toISOString(), changing,
          resumability: scan.meta.cwd !== input.cwd || writerState === "busy" ? "no" : changing || writerState === "unknown" ? "check_on_open" : "yes",
          ...(reason ? { reason } : {}),
        });
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        diagnostics.push({ sourceBasename: basename, code: error instanceof SessionAccessError ? error.code : "corrupt", message: "无法安全观察该会话正文。", ...(meta ? { sessionId: meta.sessionId, cwd: meta.cwd } : {}) });
        if (!meta) result.unattributedCount++;
      } finally { if (handle) await context.close(handle); }
    }
    // 目录项被替换时不能把两个容器的观察拼成一个成功快照。
    for (const [index, path] of [root, sessions].entries()) {
      if (!sameSessionIdentity(identities[index]!, await io.lstat(path))) throw new Error("directory changed");
    }
    entries.sort((a, b) => compareTime(b.lastActivityAt, a.lastActivityAt) || compareTime(b.createdAt, a.createdAt) || (a.sessionId === b.sessionId ? 0 : a.sessionId < b.sessionId ? -1 : 1));
    return { ...result, entries, diagnostics };
  } catch (error) {
    if (error instanceof PersistenceError || error instanceof SessionAccessError && error.code === "cwd_mismatch") throw error;
    throw new PersistenceError("ownership_lost", "list", "无法完整读取或复核会话目录。");
  }
}
