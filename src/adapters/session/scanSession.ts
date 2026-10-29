/**
 * adapters 层 JSONL 只读字节扫描入口。未来列表/持锁恢复可复用，但 T3 不取得写锁或修复文件。
 * 顺序为 fstat 固定 S → 字节分行 → fatal UTF-8 → JSON/schema → 生命周期 → 只读结果。
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { PersistenceError, SessionAccessError } from "../../contracts/session.js";
import type { SessionErrorContext, SessionMeta } from "../../contracts/session.js";
import { classifyJsonObjectPrefix } from "./jsonPrefix.js";
import type { ScanDiagnostic, ScanResult, ScanSource, ValidScanResult } from "./scanTypes.js";
import { SessionSequence } from "./sessionSequence.js";
import { SessionFormatIssue, validateSessionHeader, validateSessionRecord } from "./sessionSchema.js";

/** 扫描调优参数；只改变读取分块，不能设置跳坏行、放松校验或自动修复。 */
export interface ScanOptions {
  /** 每次 read 的最大字节数，默认 64 KiB；测试可设为 1 验证跨 UTF-8/LF 分片。 */
  chunkSizeBytes?: number;
}

/** 安全提取 Node 文件错误码以映射访问拒绝；不把错误原文、路径或 stack 交付调用方。 */
function ioCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/**
 * 提取已经能解析的定位字段，供坏 schema/引用的诊断使用；不读取正文或参数。
 * 不强制错误记录本身已通过 schema，只保存类型合理的 seq/turn/调用引用。
 */
function recordContext(value: unknown): SessionErrorContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const context: SessionErrorContext = {};
  if (typeof record.seq === "number" && Number.isSafeInteger(record.seq)) context.seq = record.seq;
  if (typeof record.turnId === "string") context.turnId = record.turnId;

  if (typeof record.payload === "object" && record.payload !== null && !Array.isArray(record.payload)) {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.callMessageSeq === "number" && Number.isSafeInteger(payload.callMessageSeq)) {
      context.callMessageSeq = payload.callMessageSeq;
    }
    if (typeof payload.toolCallId === "string") context.toolCallId = payload.toolCallId;
  }
  return context;
}

/**
 * 扫描借用的普通文件描述符，仅解释初次 fstat 得到的 [0,S)。
 * 调用方提供与 header 对应的受管 basename 并负责关闭；本函数不创建路径、不取得锁。
 * 返回 status 联合：损坏/不支持没有可恢复历史；访问/读取失败抛稳定访问错误。
 * 分块读取不等于单行内存有界；JSON.parse 仍需完整行，当前格式没有记录字节硬上限。
 */
async function scanFixedRange(
  handle: FileHandle,
  sourceBasename: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const chunkSize = options.chunkSizeBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new RangeError("chunkSizeBytes 必须为正安全整数。");

  const initial = await handle.stat({ bigint: true });
  if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SessionAccessError("invalid_identity", "scan", "扫描来源必须是大小可精确表示的普通文件。");
  }
  const size = Number(initial.size);
  let meta: SessionMeta | undefined;
  let sequence: SessionSequence | undefined;
  let diagnostic: ScanDiagnostic | undefined;
  let line = 1;
  let lineStart = 0;
  let validEndBytes = 0;
  let lastLfEndBytes = 0;
  let tailKind: ValidScanResult["tailKind"] = "none";

  /**
   * 消费一个完整物理行（不含 LF），外层已经给出字节右边界。
   * 每层失败都返回安全位置；仅全套校验成功后推进合法字节边界，不回收坏文件局部历史。
   */
  function consumeLine(bytes: Uint8Array, lineEndBytes: number, hasLf: boolean): ScanDiagnostic | undefined {
    let value: unknown;
    try {
      let text: string;
      try {
        // ignoreBOM:true 保留 BOM 字符，让 JSON.parse 拒绝它，而不是悄悄吞掉非法前缀。
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new SessionFormatIssue("utf8", "物理行包含非法或未完成 UTF-8 编码。");
      }

      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new SessionFormatIssue("json", "物理行不是完整合法 JSON 对象。");
      }

      if (!meta) {
        const header = validateSessionHeader(value, sourceBasename);
        meta = { sessionId: header.sessionId, createdAt: header.createdAt, cwd: header.cwd };
        sequence = new SessionSequence(meta.createdAt);
      } else {
        sequence!.accept(validateSessionRecord(value));
      }

      validEndBytes = lineEndBytes;
      if (hasLf) lastLfEndBytes = lineEndBytes;
      return undefined;
    } catch (error) {
      if (!(error instanceof SessionFormatIssue)) throw error;
      return { code: error.code, message: error.message, line, byteOffset: lineStart, lineEndBytes, ...recordContext(value) };
    }
  }

  // 每次 read 使用显式位置和 min(S-position)，追加文件不会扩大本次可解释范围。
  // fragments 只拼当前物理行：LF 即使跨 read，也按字节而不是按解码后的字符串切分。
  let position = 0;
  let fragments: Uint8Array[] = [];
  while (position < size && !diagnostic) {
    const buffer = Buffer.alloc(Math.min(chunkSize, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      diagnostic = { code: "source_changed", message: "扫描来源在初始字节范围读完前缩短。", line, byteOffset: lineStart, lineEndBytes: position };
      break;
    }

    const chunk = buffer.subarray(0, bytesRead);
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 0x0a) continue;
      fragments.push(chunk.subarray(segmentStart, index));
      const lineEnd = position + index + 1;
      diagnostic = consumeLine(Buffer.concat(fragments), lineEnd, true);
      fragments = [];
      if (diagnostic) break;

      line++;
      lineStart = lineEnd;
      segmentStart = index + 1;
    }
    if (!diagnostic && segmentStart < chunk.length) fragments.push(chunk.subarray(segmentStart));
    position += bytesRead;
  }

  if (!diagnostic && lineStart < size) {
    const tail = Buffer.concat(fragments);
    const prefix = classifyJsonObjectPrefix(tail);
    if (prefix === "complete") {
      diagnostic = consumeLine(tail, size, false);
      tailKind = "missing_lf";
    } else if (prefix === "incomplete" && meta) {
      // P 仍是上一条合法 LF 后边界，残片不影响 lastSeq；不向内存状态机提交半条事件。
      tailKind = "incomplete";
    } else {
      diagnostic = {
        code: "tail",
        message: meta ? "尾行不是可追加完成的 JSON/UTF-8 对象前缀。" : "header 缺失、不完整或不是合法 JSON 对象。",
        line, byteOffset: lineStart, lineEndBytes: size,
      };
    }
  }
  if (!diagnostic && !meta) {
    diagnostic = { code: "header", message: "会话文件缺少合法 header。", line: 1, byteOffset: 0, lineEndBytes: size };
  }

  // 结束观测只用于 changing 提示，不能把它当成持锁重扫或原子快照的替代品。
  const final = await handle.stat({ bigint: true });
  const source: ScanSource = {
    sourceBasename, dev: initial.dev, ino: initial.ino, observedSizeBytes: size,
    changing: initial.dev !== final.dev || initial.ino !== final.ino || initial.size !== final.size ||
      initial.mtimeNs !== final.mtimeNs || initial.ctimeNs !== final.ctimeNs,
  };
  if (diagnostic) {
    const kind = diagnostic.code === "unsupported" ? "unsupported" : "corrupt";
    return { ...source, status: "rejected", tailKind: kind, logState: kind, diagnostic };
  }

  const summary = sequence!.finish();
  const logState = tailKind === "incomplete" ? "torn_tail" : tailKind === "missing_lf" ? "missing_lf"
    : summary.statistics.turnCount === 0 ? "empty" : summary.statistics.interruptedTurnCount > 0 ? "interrupted" : "complete";
  return {
    ...source, status: "valid", meta: meta!, validEndBytes, lastLfEndBytes,
    lastSeq: sequence!.lastSeq, tailKind, logState, ...summary,
  };
}

/**
 * 为借用句柄提供稳定的 I/O 错误边界；未来持锁恢复与测试可以复用，不转移句柄所有权。
 * 输入输出与固定范围扫描相同；所有已开始的读取都实际 settle 后才返回/拒绝，不关闭句柄。
 * JSON/schema/语义损坏返回 rejected，底层访问异常转成安全 SessionAccessError。
 */
export async function scanSessionHandle(handle: FileHandle, sourceBasename: string, options: ScanOptions = {}): Promise<ScanResult> {
  try {
    return await scanFixedRange(handle, sourceBasename, options);
  } catch (error) {
    if (error instanceof SessionAccessError || error instanceof RangeError) throw error;
    throw new SessionAccessError(ioCode(error) === "ENOENT" ? "not_found" : "permission_denied", "scan", "无法只读扫描会话描述符。");
  }
}

/**
 * 关闭扫描入口自己打开的描述符；finally 等待它完成，避免返回结果时仍遗留资源。
 * 输入为已打开的只读句柄；关闭异常转 close_failed，优先于原扫描结果交由上层存储收尾。
 */
async function closeScanHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw new PersistenceError("close_failed", "scan_cleanup", "扫描描述符关闭失败。");
  }
}

/**
 * 按只读模式打开路径并完成扫描，供不持有正文句柄的调用方使用。
 * 不创建目录或文件；拒绝末端符号链接及非普通文件，finally 始终等待描述符关闭。
 * 返回合法/拒绝扫描结果；缺文件/权限抛 SessionAccessError，关闭失败抛 PersistenceError。
 */
export async function scanSessionFile(path: string, options: ScanOptions = {}): Promise<ScanResult> {
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK 避免 FIFO 在 fstat 前阻塞；它不会改变普通文件的读取语义。
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return await scanSessionHandle(handle, basename(path), options);
  } catch (error) {
    if (error instanceof SessionAccessError || error instanceof PersistenceError || error instanceof RangeError) throw error;
    throw new SessionAccessError(ioCode(error) === "ENOENT" ? "not_found" : "permission_denied", "scan", "无法只读打开或扫描会话文件。");
  } finally {
    if (handle) await closeScanHandle(handle);
  }
}
