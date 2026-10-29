import { createRequire } from "node:module";
import type { SessionLockAdapter as Adapter } from "../../src/adapters/session/SessionLockAdapter.js";
import type { SessionLock } from "../../src/contracts/session-lock.js";

// 测试实际构建产物；native-module 的加载时机也必须由生产 adapter 自己控制。
const { SessionLockAdapter } = await import(process.env.YUCLI_LOCK_MODULE!) as { SessionLockAdapter: typeof Adapter };
const adapter = new SessionLockAdapter({ storageRoot: process.env.YUCLI_LOCK_ROOT! });
let lock: SessionLock | undefined;
process.on("message", async (message: { action: string; sessionId: string; requestId: number }) => {
  try {
    let value: unknown;
    if (message.action === "acquire") {
      lock = await adapter.acquire(message.sessionId);
      value = "held";
    } else if (message.action === "probe") value = await adapter.probe(message.sessionId);
    else if (message.action === "release") {
      await lock?.release();
      lock = undefined;
      value = "released";
    } else if (message.action === "shared") {
      // 直接以只读描述符取得真实 shnb，确认生产 probe 也使用共享锁而不是误用 exnb。
      const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
      const native = createRequire(import.meta.url)("fs-ext") as { flockSync(fd: number, operation: string): void };
      const fd = fs.openSync(`${process.env.YUCLI_LOCK_ROOT}/locks/${message.sessionId}.lock`, "r");
      native.flockSync(fd, "shnb");
      process.once("disconnect", () => fs.closeSync(fd));
      value = "shared";
    }
    process.send?.({ requestId: message.requestId, value });
  } catch (error) {
    const known = error as { code?: string; name?: string };
    process.send?.({ requestId: message.requestId, error: { code: known.code, name: known.name } });
  }
});
process.send?.({ ready: true, node: process.versions.node, arch: process.arch });
