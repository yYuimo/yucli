import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { scanSessionFile } from "../src/adapters/session/scanSession.js";
import { entryModes, processSandbox } from "./sessionProcessHelpers.js";

const exec = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** 用 header 读取真实子进程产生的身份；不从终端输出推测 seq 或成功状态。 */
async function sessions(root: string) {
  return Promise.all((await readdir(join(root, "sessions"))).map(async (name) => {
    const path = join(root, "sessions", name); const bytes = await readFile(path);
    const header = JSON.parse(bytes.toString().split("\n")[0]!) as { sessionId: string; cwd: string };
    return { path, bytes, id: header.sessionId, cwd: header.cwd };
  }));
}
/** 确认进程真的处于停止态，避免把尚未生效的 SIGSTOP 当成暂停保护证据。 */
async function stopped(pid: number) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const { stdout } = await exec("/bin/ps", ["-o", "state=", "-p", String(pid)]);
    if (stdout.trim().startsWith("T")) return;
  }
  throw new Error("SIGSTOP was not observed");
}

describe.each(entryModes)("T9 %s 真实 CLI 重启/信号/目录边界", (mode) => {
  it("A01：帮助/版本/用法/空 REPL/help 不落盘，prompt 仍无持久化", async () => {
    const ctx = await processSandbox();
    try {
      for (const args of [["--help"], ["--version"], ["--all"]]) {
        const child = ctx.launch(mode, { args, key: "" }); expect(await child.done).toMatchObject({ code: args[0] === "--all" ? 2 : 0 });
        expect(await readdir(ctx.home)).toEqual([]);
      }
      for (const questions of ["", "\n/help\n/exit\n"]) {
        const child = ctx.launch(mode); await child.wait(() => child.prompts() === 1); child.end(questions); expect(await child.done).toMatchObject({ code: 0 });
        expect(await readdir(ctx.home)).toEqual([]);
      }
      const prompt = ctx.launch(mode, { args: ["--prompt", "single"] }); expect(await prompt.done).toMatchObject({ code: 0 });
      expect(await readdir(ctx.home)).toEqual([]); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });

  it("A09：重启使用新模型，只在首次新请求前提示旧/当前摘要一次", async () => {
    const ctx = await processSandbox();
    try {
      const first = ctx.launch(mode, { model: "old-model" }); await first.wait(() => first.prompts() === 1); first.end("old\n"); await first.done;
      const source = (await sessions(ctx.root))[0]!;
      const second = ctx.launch(mode, { args: ["--resume", source.id], model: "current-model" }); await second.wait(() => second.prompts() === 1);
      expect(second.stderr).not.toContain("恢复历史使用"); await second.line("first-new"); await second.line("second-new"); second.end(); expect(await second.done).toMatchObject({ code: 0 });
      expect(second.stderr.split("恢复历史使用")).toHaveLength(2); expect(second.stderr).toContain("opencode-go/old-model"); expect(second.stderr).toContain("opencode-go/current-model");
      expect(ctx.requests.slice(1).every((request) => request.model === "current-model")).toBe(true);
      const rows = (await readFile(source.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.payload?.role === "user").slice(1).every((row) => row.runtimeProfile.model === "current-model")).toBe(true);
      expect(JSON.stringify(ctx.requests)).not.toMatch(/"runtimeProfile":|"provider":/u);
    } finally { await ctx.dispose(); }
  });

  it("A04/A05：工具成功后退出，新进程恢复仅投影历史，不重读旧工具或重复旧请求", async () => {
    const ctx = await processSandbox();
    try {
      await writeFile(join(ctx.cwd, "README.md"), "旧工具内容😀");
      const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1); first.end("read\n/exit\n");
      expect(await first.done).toMatchObject({ code: 0 }); const source = (await sessions(ctx.root))[0]!; const oldBytes = source.bytes;
      const before = await lstat(source.path); expect(ctx.requests).toHaveLength(2);
      await writeFile(join(ctx.cwd, "README.md"), "不能作为旧结果重读的新内容");
      const second = ctx.launch(mode, { args: ["--resume", source.id] }); await second.wait(() => second.prompts() === 1); second.end("新问题\n");
      expect(await second.done).toMatchObject({ code: 0 }); expect(ctx.requests).toHaveLength(3);
      const messages = ctx.requests.at(-1)!.messages;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
      expect(messages[2]!.content).toBe("旧工具内容😀"); expect(messages.at(-1)!.content).toBe("新问题");
      expect(JSON.stringify(messages)).not.toMatch(/"(?:ok|seq|callMessageSeq|runtimeProfile|assistantId)":/u);
      const after = await lstat(source.path); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      const bytes = await readFile(source.path); expect(bytes.subarray(0, oldBytes.length)).toEqual(oldBytes);
      const scan = await scanSessionFile(source.path); expect(scan).toMatchObject({ status: "valid", tailKind: "none", lastSeq: 9 });
      if (scan.status === "valid") expect(new Set(scan.turns.map((turn) => turn.turnId)).size).toBe(2);
      expect(await readdir(ctx.root)).not.toContain("recovery");
    } finally { await ctx.dispose(); }
  });

  it("A06/D02：成功窗口整组保留20，失败/被杀中断不入历史；重启不裁剪磁盘", async () => {
    const ctx = await processSandbox();
    try {
      await writeFile(join(ctx.cwd, "README.md"), "old tool");
      const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1);
      await first.line("read");
      for (let i = 0; i < 21; i++) { if (i === 10) await first.line("fail"); await first.line(`success-${i}`); }
      first.write("hang\n"); await first.wait(() => first.stdout.endsWith("partial"));
      const source = (await sessions(ctx.root))[0]!; const bytes = await readFile(source.path);
      first.signal("SIGKILL"); expect(await first.done).toMatchObject({ signal: "SIGKILL" });
      const restarted = ctx.launch(mode, { args: ["--continue"] }); await restarted.wait(() => restarted.prompts() === 1); restarted.end("new\n");
      expect(await restarted.done).toMatchObject({ code: 0 });
      const messages = ctx.requests.at(-1)!.messages; expect(messages).toHaveLength(41);
      expect(messages[0]).toEqual({ role: "user", content: "success-1" });
      expect(messages.at(-1)).toEqual({ role: "user", content: "new" });
      expect(messages.some((message) => message.content === "fail" || message.content === "hang" || message.role === "tool")).toBe(false);
      expect((await readFile(source.path)).subarray(0, bytes.length)).toEqual(bytes);
      const scan = await scanSessionFile(source.path);
      expect(scan).toMatchObject({ status: "valid", statistics: { turnCount: 25, interruptedTurnCount: 1 } });
      if (scan.status === "valid") expect(scan.recentSuccessfulTurns).toHaveLength(20);
    } finally { await ctx.dispose(); }
  }, 15_000);

  it("D01/D02：闲置/SIGSTOP 写者不被抢占；关闭或死亡后接管，锁 inode 保留", async () => {
    const ctx = await processSandbox();
    try {
      const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1); await first.line("first");
      const source = (await sessions(ctx.root))[0]!; const lockPath = join(ctx.root, "locks", `${source.id}.lock`); const identity = await lstat(lockPath);
      const locks = new SessionLockAdapter({ storageRoot: ctx.root });
      expect(await locks.probe(source.id)).toBe("busy"); first.signal("SIGSTOP"); await stopped(first.pid!);
      const contender = ctx.launch(mode, { args: ["--continue"] }); expect(await contender.done).toMatchObject({ code: 5 }); expect(contender.stderr).toContain("session_busy");
      expect(ctx.requests).toHaveLength(1); expect(await locks.probe(source.id)).toBe("busy");
      first.signal("SIGCONT"); first.end("/exit\n"); expect(await first.done).toMatchObject({ code: 0 }); expect(await locks.probe(source.id)).toBe("available");
      const second = ctx.launch(mode, { args: ["--resume", source.id] }); await second.wait(() => second.prompts() === 1);
      second.signal("SIGKILL"); await second.done; expect(await locks.probe(source.id)).toBe("available");
      const final = ctx.launch(mode, { args: ["--resume", source.id] }); await final.wait(() => final.prompts() === 1); final.end(); expect(await final.done).toMatchObject({ code: 0 });
      const preserved = await lstat(lockPath); expect([preserved.dev, preserved.ino]).toEqual([identity.dev, identity.ino]);
    } finally { await ctx.dispose(); }
  });

  it("A07：new/clear 后退出；另一进程仍能恢复旧文件，原记录不被重写", async () => {
    const ctx = await processSandbox();
    try {
      const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1); await first.line("old");
      const old = (await sessions(ctx.root))[0]!;
      await first.line("/new"); await first.line("new"); await first.line("/clear"); await first.line("third"); first.end();
      expect(await first.done).toMatchObject({ code: 0 }); expect(await sessions(ctx.root)).toHaveLength(3); expect(await readFile(old.path)).toEqual(old.bytes);
      const second = ctx.launch(mode, { args: ["--resume", old.id] }); await second.wait(() => second.prompts() === 1); second.end("again\n");
      expect(await second.done).toMatchObject({ code: 0 }); expect(ctx.requests.at(-1)?.messages).toEqual([
        { role: "user", content: "old" }, { role: "assistant", content: "ok" }, { role: "user", content: "again" },
      ]);
    } finally { await ctx.dispose(); }
  });

  it("A08：父子/其他目录、目录改名拒绝跨 cwd；符号链接同 realpath 可恢复", async () => {
    const ctx = await processSandbox();
    try {
      const first = ctx.launch(mode); await first.wait(() => first.prompts() === 1); first.end("old\n"); await first.done;
      const source = (await sessions(ctx.root))[0]!; const nested = join(ctx.cwd, "nested"); await mkdir(nested);
      for (const cwd of [ctx.directory, nested, ctx.home]) {
        const list = ctx.launch(mode, { cwd, args: ["--sessions"], key: "" }); expect(await list.done).toMatchObject({ code: 0 }); expect(list.stdout).not.toContain(source.id);
        const all = ctx.launch(mode, { cwd, args: ["--sessions", "--all"], key: "" }); await all.done; expect(all.stdout).toContain(source.id); expect(all.stdout).toContain("仅可预览");
        const denied = ctx.launch(mode, { cwd, args: ["--resume", source.id] }); expect(await denied.done).toMatchObject({ code: 5 }); expect(denied.stderr).toContain("cwd_mismatch");
      }
      const alias = join(ctx.directory, "alias"); await symlink(ctx.cwd, alias);
      const allowed = ctx.launch(mode, { cwd: alias, args: ["--resume", source.id] }); await allowed.wait(() => allowed.prompts() === 1); allowed.end(); expect(await allowed.done).toMatchObject({ code: 0 });
      const renamed = join(ctx.directory, "renamed"); await rename(ctx.cwd, renamed);
      const denied = ctx.launch(mode, { cwd: renamed, args: ["--resume", source.id] }); expect(await denied.done).toMatchObject({ code: 5 }); expect(denied.stderr).toContain("cwd_mismatch");
      expect(sha(await readFile(source.path))).toBe(sha(source.bytes)); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  }, 15_000);

  it("A08：真实 Git worktree 仍有独立 cwd，global 仅预览，不创建新 commit", async () => {
    const ctx = await processSandbox();
    try {
      const primary = join(ctx.directory, "clone"); const linked = join(ctx.directory, "worktree");
      // 只借已有对象，临时 clone/worktree 的 Git 元数据不写入被测仓库，不 checkout .env。
      await exec("git", ["clone", "--quiet", "--shared", "--no-checkout", repository, primary]);
      await exec("git", ["-C", primary, "worktree", "add", "--detach", "--no-checkout", linked, "HEAD"]);
      const first = ctx.launch(mode, { cwd: primary }); await first.wait(() => first.prompts() === 1); first.end("worktree question\n"); await first.done;
      const source = (await sessions(ctx.root))[0]!;
      const different = ctx.launch(mode, { cwd: linked, args: ["--resume", source.id] }); expect(await different.done).toMatchObject({ code: 5 }); expect(different.stderr).toContain("cwd_mismatch");
      const list = ctx.launch(mode, { cwd: linked, args: ["--sessions", "--all"], key: "" }); expect(await list.done).toMatchObject({ code: 0 }); expect(list.stdout).toContain(primary); expect(ctx.requests).toHaveLength(1);
    } finally { await ctx.dispose(); }
  });
});
