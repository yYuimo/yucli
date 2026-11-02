/** 测试侧真实 I/O 观测：只发送阶段和相对时间，不记录消息、认证、正文或路径。 */
import type { SessionFileIO } from "../../src/adapters/session/sessionFileIO.js";

const target = process.env.YUCLI_TEST_TARGET === "built" ? "dist" : "src";
const { nodeSessionFileIO: io } = await import(new URL(
  `../../${target}/adapters/session/sessionFileIO.${target === "dist" ? "js" : "ts"}`, import.meta.url,
).href) as { nodeSessionFileIO: SessionFileIO };
const began = performance.now();
let next = 0;

/** 每个开始/结束共享编号，父进程超限时可区分网络等待、取消和持久化屏障。 */
function report(stage: string, id = ++next) {
  process.send?.({ stage, id, ms: Math.round(performance.now() - began) });
  return id;
}

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
  // 只包裹原 Promise 并保留结果/拒绝；不插入延迟、不替代真实 fsync、不吞掉原异常。
  Object.assign(io, { [method]: async (...args: Parameters<typeof original>) => {
    const id = report(`${method}:start`);
    try {
      const value = await Reflect.apply(original, io, args);
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
