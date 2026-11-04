import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { scanSessionFile } from "../src/adapters/session/scanSession.js";
import { entryModes, processSandbox, type EntryMode } from "./sessionProcessHelpers.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** 从真实落盘 header 取得 ID，初次 user 写入挂起时正文仍只有可解释的前缀。 */
async function identity(path: string) { return JSON.parse((await readFile(path, "utf8")).split("\n")[0]!) as { sessionId: string }; }

const faultCases = entryModes.flatMap((mode) => ["write_hang", "close_reject", "sync_reject", mode === "source" ? "write_late" : "write_late_reject"].map((fault) => ({ mode, fault })));
it.concurrent.each(faultCases)("T9 $mode/$fault：真实 CLI 故障退出、不提前解锁，后继进程重验恢复", async ({ mode, fault }) => {
  const ctx = await processSandbox();
  try {
    const child = ctx.launch(mode, { fault }); await child.wait(() => child.prompts() === 1);
    const began = performance.now(); child.end("first\n" + (fault === "close_reject" ? "/exit\n" : "") + "must-not-execute\n");
    const checkpoint = await child.checkpoint(fault === "sync_reject" ? "sync_rejected" : "held");
    const path = checkpoint.path as string; const { sessionId } = await identity(path); const bytes = await readFile(path);
    const locks = new SessionLockAdapter({ storageRoot: ctx.root });
    const lockPath = join(ctx.root, "locks", `${sessionId}.lock`); const lockBefore = await lstat(lockPath);
    if (fault !== "sync_reject") {
      expect(await locks.probe(sessionId)).toBe("busy"); child.signal("SIGINT");
      await child.wait(() => child.stderr.includes("正在停止执行并关闭资源"), fault.startsWith("write_") ? 34_000 : 6000);
      // 已进入收尾仍不能先解锁；第二次 Ctrl+C 也不能改为 130 或重置 5 秒期限。
      expect(await locks.probe(sessionId)).toBe("busy"); child.signal("SIGINT");
      if (fault.startsWith("write_late")) child.child.send!({ action: "settle_after_timeout" });
    }
    expect(await child.done).toMatchObject({ code: 5, signal: null });
    const elapsed = performance.now() - began;
    if (fault === "write_hang") { expect(elapsed).toBeGreaterThanOrEqual(34_500); expect(elapsed).toBeLessThan(45_000); expect(child.stderr).toContain("io_timeout"); }
    if (fault === "close_reject") { expect(elapsed).toBeGreaterThanOrEqual(4900); expect(elapsed).toBeLessThan(12_000); expect(child.stderr).toContain("close_failed"); }
    if (fault.startsWith("write_late")) {
      expect(elapsed).toBeGreaterThanOrEqual(29_900); expect(elapsed).toBeLessThan(40_000);
      expect(child.messages.some((message) => message.event === "late_settled")).toBe(true);
      expect(child.stderr).toContain("io_timeout"); expect(child.stderr).not.toContain("5 秒内关闭");
    } else if (fault !== "sync_reject") expect(child.stderr).toContain("5 秒内关闭");
    else expect(child.stderr).toContain("sync_failed");
    expect(child.stderr).not.toMatch(/PRIVATE|Authorization|t9-local-key/u); expect(child.stderr).not.toContain(ctx.directory);
    expect(ctx.requests).toHaveLength(fault === "close_reject" ? 1 : 0);
    expect(await locks.probe(sessionId)).toBe("available"); const lockAfter = await lstat(lockPath);
    expect([lockAfter.dev, lockAfter.ino]).toEqual([lockBefore.dev, lockBefore.ino]); expect(await readFile(path)).toEqual(bytes);

    const restarted = ctx.launch(mode, { args: ["--resume", sessionId] }); await restarted.wait(() => restarted.prompts() === 1); restarted.end("after-restart\n");
    expect(await restarted.done).toMatchObject({ code: 0 });
    const expectedMessages = fault === "close_reject" ? [{ role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "after-restart" }] : [{ role: "user", content: "after-restart" }];
    expect(ctx.requests.at(-1)?.messages).toEqual(expectedMessages);
    const scan = await scanSessionFile(path); expect(scan).toMatchObject({ status: "valid", tailKind: "none", lastSeq: fault.startsWith("write_") ? 3 : fault === "sync_reject" ? 4 : 6 });
    if (fault.startsWith("write_")) {
      const recovery = join(ctx.root, "recovery", sessionId); const backup = (await readdir(recovery)).find((name) => name.endsWith(".bak"))!;
      expect(await readFile(join(recovery, backup))).toEqual(bytes); expect(restarted.stderr).toContain("truncate_tail");
    } else { expect(await readdir(ctx.root)).not.toContain("recovery"); expect(restarted.stderr).toContain("尾部 none"); }
  } finally { await ctx.dispose(); }
}, 50_000);

const repairCases: { mode: EntryMode; fault: string; action: "truncate" | "lf"; after: boolean }[] = entryModes.flatMap((mode) => [
  { mode, fault: "truncate_before", action: "truncate" as const, after: false },
  { mode, fault: "truncate_after", action: "truncate" as const, after: true },
  { mode, fault: "lf_before", action: "lf" as const, after: false },
  { mode, fault: "lf_after", action: "lf" as const, after: true },
  { mode, fault: "backup_hang", action: "truncate" as const, after: false },
]);
it.concurrent.each(repairCases)("T9 B08/B09 $mode/$fault：修复中真实 SIGKILL 后按实际字节重扫", async ({ mode, fault, action, after }) => {
  const ctx = await processSandbox();
  try {
    const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1); first.end("old\n"); expect(await first.done).toMatchObject({ code: 0 });
    const path = join(ctx.root, "sessions", (await readdir(join(ctx.root, "sessions")))[0]!); const { sessionId } = await identity(path); const valid = await readFile(path);
    const original = action === "lf" ? valid.subarray(0, -1) : Buffer.concat([valid, Buffer.from('{"seq":4,"payload":{"content":"残片😀')]);
    await writeFile(path, original); const before = await lstat(path);
    const interrupted = ctx.launch(mode, { args: ["--resume", sessionId], fault }); await interrupted.checkpoint();
    expect(await new SessionLockAdapter({ storageRoot: ctx.root }).probe(sessionId)).toBe("busy");
    expect(ctx.requests).toHaveLength(1); // 暂停点在 openWrite/repair 内，绝不能已有新请求。
    const actual = await readFile(path); expect(actual).toEqual(after ? valid : original);
    interrupted.signal("SIGKILL"); expect(await interrupted.done).toMatchObject({ signal: "SIGKILL" });
    const recovery = join(ctx.root, "recovery", sessionId); const preservedNames = await readdir(recovery);
    const restarted = ctx.launch(mode, { args: ["--resume", sessionId] }); await restarted.wait(() => restarted.prompts() === 1); restarted.end("new\n"); expect(await restarted.done).toMatchObject({ code: 0 });
    expect(ctx.requests).toHaveLength(2); expect(ctx.requests.at(-1)?.messages).toEqual([{ role: "user", content: "old" }, { role: "assistant", content: "ok" }, { role: "user", content: "new" }]);
    const names = await readdir(recovery); expect(names).toEqual(expect.arrayContaining(preservedNames));
    expect(names.filter((name) => name.endsWith(".bak"))).toHaveLength(after ? 1 : 2);
    const completeBackups = await Promise.all(names.filter((name) => name.endsWith(".repair.json")).map(async (name) => {
      const manifest = JSON.parse(await readFile(join(recovery, name), "utf8")) as { sourceSha256: string; originalSizeBytes: number; sourceBasename: string };
      const backup = await readFile(join(recovery, name.replace(/\.repair\.json$/u, ".jsonl.bak")));
      expect(manifest).toMatchObject({ sourceSha256: hash(original), originalSizeBytes: original.length, sourceBasename: basename(path) });
      expect(hash(backup)).toBe(hash(original)); expect(backup).toEqual(original); return backup;
    }));
    expect(completeBackups.length).toBeGreaterThan(0);
    const final = await readFile(path); expect(final.subarray(0, valid.length)).toEqual(valid);
    const repaired = await scanSessionFile(path); expect(repaired).toMatchObject({ status: "valid", lastSeq: 6, tailKind: "none" });
    const afterStat = await lstat(path); expect([afterStat.dev, afterStat.ino]).toEqual([before.dev, before.ino]);
    expect(restarted.stderr).toContain(after ? "尾部 none" : action === "lf" ? "append_lf" : "truncate_tail");
  } finally { await ctx.dispose(); }
}, 20_000);
