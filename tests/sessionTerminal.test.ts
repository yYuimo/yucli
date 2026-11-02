import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { scanSessionFile } from "../src/adapters/session/scanSession.js";
import { entryModes, processSandbox } from "./sessionProcessHelpers.js";

/** 取得普通 CLI 实际创建的会话供真实终端选择，不手造 picker 的编号或存储读模型。 */
async function stored(root: string) {
  return Promise.all((await readdir(join(root, "sessions"))).map(async (name) => {
    const path = join(root, "sessions", name); const bytes = await readFile(path);
    const rows = bytes.toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    return { path, bytes, id: rows[0].sessionId as string, prompt: rows[1]?.payload.content as string | undefined };
  }));
}

describe.each(entryModes)("T9 %s 真实 PTY：CLI/REPL 共用行选择", (mode) => {
  it("E01/E12：无密钥浏览/取消成功；确认选择才报配置错误，正文无修改且锁可用", async () => {
    const ctx = await processSandbox();
    try {
      const seed = ctx.launch(mode); await seed.wait(() => seed.prompts() === 1); seed.end("old\n"); await seed.done;
      const source = (await stored(ctx.root))[0]!; const locks = new SessionLockAdapter({ storageRoot: ctx.root });
      const browse = ctx.launch(mode, { args: ["--resume"], pty: true, key: "" }); await browse.wait(() => browse.stdout.includes("编号 / a"));
      expect(browse.stdout).not.toContain(source.id); expect(await locks.probe(source.id)).toBe("available");
      browse.write("q\n"); expect(await browse.done).toMatchObject({ code: 0 });
      const selected = ctx.launch(mode, { args: ["--resume"], pty: true, key: "" }); await selected.wait(() => selected.stdout.includes("编号 / a")); selected.write("1\n");
      expect(await selected.done).toMatchObject({ code: 3 }); expect(selected.stdout).toContain("配置错误");
      expect(await readFile(source.path)).toEqual(source.bytes); expect(await locks.probe(source.id)).toBe("available"); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });

  it("E04：选前文件消失保持原编号；只有 r 刷新后才将编号映射到其他 ID", async () => {
    const ctx = await processSandbox();
    try {
      const seed = ctx.launch(mode); await seed.wait(() => seed.prompts() === 1); seed.end("older\n/new\nnewer\n"); await seed.done;
      const sources = await stored(ctx.root); const newer = sources.find((item) => item.prompt === "newer")!;
      const picker = ctx.launch(mode, { args: ["--resume"], pty: true }); await picker.wait(() => picker.stdout.includes("编号 / a"));
      expect(picker.stdout).toMatch(/1\) [^\r\n]*newer/u); await rm(newer.path);
      picker.write("1\n"); await picker.wait(() => picker.stdout.includes("not_found"));
      const before = picker.stdout.split("编号快照保持不变").length; picker.write("1\n"); await picker.wait(() => picker.stdout.split("编号快照保持不变").length > before);
      expect(picker.stdout.split("恢复会话：")).toHaveLength(2); expect(ctx.requests).toHaveLength(2);
      picker.write("r\n"); await picker.wait(() => picker.stdout.split("恢复会话：").length === 3 && /1\) [^\r\n]*older/u.test(picker.stdout.split("恢复会话：").at(-1) ?? ""));
      expect(picker.stdout.split("恢复会话：").at(-1)).toMatch(/1\) [^\r\n]*older/u);
      picker.write("1\n"); await picker.wait(() => picker.prompts() === 1); picker.end("after-picker\n"); expect(await picker.done).toMatchObject({ code: 0 });
      expect(ctx.requests.at(-1)?.messages[0]?.content).toBe("older");
    } finally { await ctx.dispose(); }
  });

  it("E04/E11：列举后竞争者取锁，访问拒绝不自动刷新/换候选；释放后同编号可选", async () => {
    const ctx = await processSandbox();
    try {
      const seed = ctx.launch(mode); await seed.wait(() => seed.prompts() === 1); seed.end("old\n"); await seed.done;
      const source = (await stored(ctx.root))[0]!;
      const picker = ctx.launch(mode, { args: ["--resume"], pty: true }); await picker.wait(() => picker.stdout.includes("编号 / a"));
      const held = await new SessionLockAdapter({ storageRoot: ctx.root }).acquire(source.id);
      try { picker.write("1\n"); await picker.wait(() => picker.stdout.includes("session_busy")); expect(picker.stdout.split("恢复会话：")).toHaveLength(2); }
      finally { await held.release(); }
      picker.write("1\n"); await picker.wait(() => picker.prompts() === 1); picker.end(); expect(await picker.done).toMatchObject({ code: 0 }); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });

  it("E03/E05/E06/E07：空 current/all 可 a/r/q，空会话同 cwd 可选，当前会话不重复打开", async () => {
    const ctx = await processSandbox();
    try {
      const writer = new SessionFileAdapter({ storageRoot: ctx.root }); const empty = await writer.create(ctx.cwd); await writer.close();
      const picker = ctx.launch(mode, { args: ["--resume"], pty: true }); await picker.wait(() => picker.stdout.includes("编号 / a"));
      expect(picker.stdout).toContain("当前目录没有可恢复会话"); expect(picker.stdout).toContain("隐藏空会话：1");
      picker.write("/new\n"); await picker.wait(() => picker.stdout.includes("无效编号")); expect(ctx.requests).toHaveLength(0);
      picker.write("a\n"); await picker.wait(() => picker.stdout.includes("[all]") && /1\) [^\r\n]*empty/u.test(picker.stdout)); expect(picker.stdout).toContain("empty");
      picker.write("1\n"); await picker.wait(() => picker.prompts() === 1); await picker.line("first");
      const prior = picker.stdout.split("恢复会话：").length; picker.write("/resume\n"); await picker.wait(() => picker.stdout.split("恢复会话：").length > prior && picker.stdout.includes("当前会话"));
      picker.write("1\n"); await picker.wait(() => picker.prompts() === 3); picker.end(); expect(await picker.done).toMatchObject({ code: 0 });
      const scan = await scanSessionFile((await stored(ctx.root))[0]!.path); expect(scan).toMatchObject({ status: "valid", meta: { sessionId: empty.snapshot.meta.sessionId }, lastSeq: 3 }); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });

  it("E05：all 的其他 cwd 只预览，输入编号不加载配置或取得写锁", async () => {
    const ctx = await processSandbox();
    try {
      const seed = ctx.launch(mode); await seed.wait(() => seed.prompts() === 1); seed.end("old\n"); await seed.done;
      const source = (await stored(ctx.root))[0]!;
      const picker = ctx.launch(mode, { cwd: ctx.home, args: ["--resume", "--all"], pty: true, key: "" }); await picker.wait(() => picker.stdout.includes("编号 / a"));
      picker.write("1\n"); await picker.wait(() => picker.stdout.split("其他工作目录，仅可预览。").length >= 3);
      expect(await new SessionLockAdapter({ storageRoot: ctx.root }).probe(source.id)).toBe("available");
      picker.write("q\n"); expect(await picker.done).toMatchObject({ code: 0 }); expect(ctx.requests).toHaveLength(1); expect(await readFile(source.path)).toEqual(source.bytes);
    } finally { await ctx.dispose(); }
  });

  it.each(["input", "output"] as const)("E09：只有 %s 是 TTY 时仍在配置/存储前返回2", async (side) => {
    const ctx = await processSandbox();
    try {
      const picker = ctx.launch(mode, { args: ["--resume"], pty: true, ptySide: side, key: "" });
      expect(await picker.done).toMatchObject({ code: 2 }); expect(picker.stdout).toContain("stdin/stdout 都是 TTY");
      expect(await readdir(ctx.home)).toEqual([]); expect(ctx.requests).toHaveLength(0);
    } finally { await ctx.dispose(); }
  });

  it.each(["interrupt", "eof"])("E08：启动 picker %s，真实控制字符分别退出130/0", async (kind) => {
    const ctx = await processSandbox();
    try {
      const picker = ctx.launch(mode, { args: ["--resume"], pty: true, key: "" }); await picker.wait(() => picker.stdout.includes("编号 / a"));
      if (kind === "interrupt") picker.write("\x03"); else picker.end();
      expect(await picker.done).toMatchObject({ code: kind === "interrupt" ? 130 : 0 }); expect(await readdir(ctx.home)).toEqual([]); expect(ctx.requests).toHaveLength(0);
    } finally { await ctx.dispose(); }
  });

  it("E08/C07：REPL picker Ctrl+C 保留原历史；活跃 Ctrl+C 只取消当前 turn，闲置 Ctrl+C 为130", async () => {
    const ctx = await processSandbox();
    try {
      const repl = ctx.launch(mode, { pty: true }); await repl.wait(() => repl.prompts() === 1); await repl.line("good");
      repl.write("/resume\n"); await repl.wait(() => repl.stdout.includes("编号 / a")); repl.write("\x03"); await repl.wait(() => repl.prompts() === 3);
      repl.write("hang\n"); await repl.wait(() => repl.stdout.endsWith("partial")); repl.write("\x03"); await repl.wait(() => repl.prompts() === 4);
      await repl.line("next"); expect(ctx.requests.at(-1)?.messages).toEqual([{ role: "user", content: "good" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }]);
      repl.write("\x03"); expect(await repl.done).toMatchObject({ code: 130 });
      const source = (await stored(ctx.root))[0]!; const scan = await scanSessionFile(source.path);
      expect(scan.status === "valid" ? scan.turns.map((turn) => turn.outcome) : []).toEqual(["success", "cancelled", "success"]);
      expect(await new SessionLockAdapter({ storageRoot: ctx.root }).probe(source.id)).toBe("available");
    } finally { await ctx.dispose(); }
  });

  it("E08：REPL picker 真实 EOF 结束整个 REPL并释放旧会话", async () => {
    const ctx = await processSandbox();
    try {
      const repl = ctx.launch(mode, { pty: true }); await repl.wait(() => repl.prompts() === 1); await repl.line("good");
      const source = (await stored(ctx.root))[0]!; repl.write("/resume\n"); await repl.wait(() => repl.stdout.includes("编号 / a")); repl.end();
      expect(await repl.done).toMatchObject({ code: 0 }); expect(await new SessionLockAdapter({ storageRoot: ctx.root }).probe(source.id)).toBe("available");
      expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });
});
