/** 测试侧真实 I/O 观测：只发送阶段和相对时间，不记录消息、认证、正文或路径。 */
import type { SessionFileIO } from "../../src/adapters/session/sessionFileIO.js";
import type { FileHandle } from "node:fs/promises";

const target = process.env.YUCLI_TEST_TARGET === "built" ? "dist" : "src";
const { nodeSessionFileIO: io } = await import(new URL(
  `../../${target}/adapters/session/sessionFileIO.${target === "dist" ? "js" : "ts"}`, import.meta.url,
).href) as { nodeSessionFileIO: SessionFileIO };
const began = performance.now();
let next = 0;
const cancelledEnds = new WeakSet<FileHandle>();

/** 只识别取消终止行所对应的句柄；不把 JSON 内容放入观测结果，也不改写字节。 */
const originalWrite = io.write.bind(io);
io.write = async (handle, bytes, position) => {
  try {
    const row = JSON.parse(Buffer.from(bytes).toString("utf8")) as { type?: string; payload?: { outcome?: string } };
    if (row.type === "turn_end" && row.payload?.outcome === "cancelled") cancelledEnds.add(handle);
  } catch { /* 短写残片不需要分类，真实 writer/扫描器继续校验原字节。 */ }
  return originalWrite(handle, bytes, position);
};

/** 每个开始/结束共享编号，父进程超限时可区分网络等待、取消和持久化屏障。 */
function report(stage: string, id = ++next) {
  process.send?.({ stage, id, ms: Math.round(performance.now() - began) });
  return id;
}

// 额外观测业务边界；模块与真实 CLI 共享同一实例，不替换模型或绕过持久化屏障。
const suffix = target === "dist" ? "js" : "ts";
const { OpenCodeGoClient } = await import(new URL(`../../${target}/adapters/opencode-go/OpenCodeGoClient.${suffix}`, import.meta.url).href) as typeof import("../../src/adapters/opencode-go/OpenCodeGoClient.js");
const { SessionWriterAdapter } = await import(new URL(`../../${target}/adapters/session/SessionWriterAdapter.${suffix}`, import.meta.url).href) as typeof import("../../src/adapters/session/SessionWriterAdapter.js");
const { SessionLockAdapter } = await import(new URL(`../../${target}/adapters/session/SessionLockAdapter.${suffix}`, import.meta.url).href) as typeof import("../../src/adapters/session/SessionLockAdapter.js");
const { LineInput } = await import(new URL(`../../${target}/bootstrap/lineInput.${suffix}`, import.meta.url).href) as typeof import("../../src/bootstrap/lineInput.js");

process.on("SIGINT", () => { report("signal:received"); });

const originalStream = OpenCodeGoClient.prototype.stream;
OpenCodeGoClient.prototype.stream = async function* (...args) {
  const id = report("stream:start");
  try { yield* originalStream.apply(this, args); }
  finally { report("stream:settled", id); }
};

const originalAppend = SessionWriterAdapter.prototype.appendDurable;
SessionWriterAdapter.prototype.appendDurable = function (fact) {
  const kind = fact.type === "turn_end" ? `${fact.type}:${fact.end.outcome}` : fact.type;
  const id = report(`fact:${kind}:start`);
  const pending = originalAppend.call(this, fact);
  void pending.then(() => report(`fact:${kind}:fulfilled`, id), () => report(`fact:${kind}:rejected`, id));
  return pending;
};

const originalClose = SessionWriterAdapter.prototype.closeSettled;
SessionWriterAdapter.prototype.closeSettled = function () {
  const id = report("writer_close:start");
  const pending = originalClose.call(this);
  void pending.then(() => report("writer_close:fulfilled", id), () => report("writer_close:rejected", id));
  return pending;
};

const originalAcquire = SessionLockAdapter.prototype.acquire;
SessionLockAdapter.prototype.acquire = async function (...args) {
  const lock = await originalAcquire.apply(this, args);
  report("lock:acquired");
  const release = lock.release.bind(lock);
  lock.release = async () => {
    const id = report("lock_release:start");
    try { await release(); report("lock_release:fulfilled", id); }
    catch (error) { report("lock_release:rejected", id); throw error; }
  };
  return lock;
};

const originalRead = LineInput.prototype.read;
LineInput.prototype.read = function (...args) {
  const id = report("input_read:start");
  const pending = originalRead.apply(this, args);
  report("prompt:issued", id);
  void pending.then((event) => report(`input_read:${event.type}`, id), () => report("input_read:rejected", id));
  return pending;
};

const stderrWrite = process.stderr.write.bind(process.stderr);
Object.assign(process.stderr, { write(...args: Parameters<typeof stderrWrite>) {
  if (typeof args[0] === "string" && args[0].includes("取消")) report("stderr:cancel_notice");
  return Reflect.apply(stderrWrite, process.stderr, args);
} });

if (process.env.YUCLI_TEST_HOLD_CANCEL === "1") {
  const originalWrite = process.stderr.write.bind(process.stderr);
  // 受控重排两条真实输出管道：只暂扣取消文案，下一提示仍正常写 stdout。
  // 父进程确认提示已到达后用 IPC 放行，确定性验证不能用 stdout 推断 stderr 已消费。
  Object.assign(process.stderr, { write(...args: Parameters<typeof originalWrite>) {
    if (typeof args[0] === "string" && args[0].includes("取消")) {
      process.once("message", () => { Reflect.apply(originalWrite, process.stderr, args); });
      report("stderr:held");
      return true;
    }
    return Reflect.apply(originalWrite, process.stderr, args);
  } });
}

for (const method of ["write", "sync", "close"] as const) {
  const original = io[method].bind(io);
  // 默认只观测原 Promise；显式开启确认闸门时由 IPC 放行，不替代真实 fsync 或吞掉原异常。
  Object.assign(io, { [method]: async (...args: Parameters<typeof original>) => {
    const id = report(`${method}:start`);
    try {
      const value = await Reflect.apply(original, io, args);
      if (method === "sync" && cancelledEnds.has(args[0])) {
        report("turn_end_sync:native_fulfilled", id);
        cancelledEnds.delete(args[0]);
        if (process.env.YUCLI_TEST_HOLD_END_SYNC === "1") {
          // 实际 fsync 已成功，只暂扣确认。父进程用事件放行，确定性区分持久化屏障与网络取消。
          await new Promise<void>((resolve) => {
            const release = (message: { release?: string }) => {
              if (message.release !== "end_sync") return;
              process.removeListener("message", release);
              resolve();
            };
            process.on("message", release);
            report("turn_end_sync:held", id);
          });
        }
      }
      report(`${method}:fulfilled`, id);
      return value;
    } catch (error) { report(`${method}:rejected`, id); throw error; }
  } });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const id = report("fetch:start");
  const signal = args[1]?.signal;
  signal?.addEventListener("abort", () => { report("fetch:abort", id); }, { once: true });
  try {
    const response = await originalFetch(...args);
    report("fetch:headers", id);
    if (response.body) {
      const originalGetReader = response.body.getReader.bind(response.body);
      // adapter 仍直接使用真实 reader；观测其 read/cancel 的实际 settle，不构造替代响应流。
      Object.assign(response.body, { getReader() {
        const reader = originalGetReader();
        for (const method of ["read", "cancel"] as const) {
          const original = reader[method].bind(reader);
          Object.assign(reader, { [method]: async (...input: Parameters<typeof original>) => {
            const readId = report(`${method}:start`);
            try {
              const value = await Reflect.apply(original, reader, input);
              report(`${method}:fulfilled`, readId);
              return value;
            } catch (error) { report(`${method}:rejected`, readId); throw error; }
          } });
        }
        return reader;
      } });
    }
    return response;
  } catch (error) { report("fetch:rejected", id); throw error; }
};
