import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, toolCompletion } from "./helpers.js";

const source = fileURLToPath(new URL("../src/bootstrap/cli.ts", import.meta.url));
const built = fileURLToPath(new URL("../dist/bootstrap/cli.js", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
type WireMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: { id: string }[] };

describe.each(["source", "built"])("REPL/流式信号 %s 子进程", (mode) => {
  let cwd: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let requests: { messages: WireMessage[]; stream: boolean }[];
  const children: ReturnType<typeof spawn>[] = [];
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "yucli-repl-"));
    await writeFile(join(cwd, "README.md"), "fixture file");
    requests = [];
    server = await startServer(async (req, res) => {
      const body = await readJson(req) as typeof requests[number];
      requests.push(body);
      const prompt = body.messages.findLast((m) => m.role === "user")?.content;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (prompt === "save-fail") {
        // 当前模型请求之前 user 已确认；破坏临时 sessions 权限让下一保存屏障拒绝。
        await chmod(join(cwd, ".yucli", "sessions"), 0o755);
        res.end(completionSse(completion("shown but not committed")));
      } else if (prompt === "hang") res.write(sseFrame(streamChunk({ content: "partial" })));
      else if (prompt === "fail") res.end(sseFrame(streamChunk({ content: "partial" })));
      else if (prompt === "read" && body.messages.at(-1)?.role === "user") res.end(completionSse(toolCompletion(), { prompt_tokens: 2, completion_tokens: 3 }));
      else res.end(completionSse(completion("ok"), { prompt_tokens: 2, completion_tokens: 3 }));
    });
  });
  afterEach(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    children.length = 0;
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  function launch(args: string[] = [], timeoutMs = "2000") {
    const child = spawn(process.execPath, [...(mode === "source" ? ["--import", tsx, source] : [built]), ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, OPENCODE_GO_API_KEY: "fake-key", OPENCODE_GO_BASE_URL: server.baseUrl,
        YUCLI_REQUEST_TIMEOUT_MS: timeoutMs }, stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    const done = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    async function waitFor(predicate: () => boolean) {
      const until = Date.now() + 4000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`child observation timed out: ${stdout} / ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const prompts = () => stdout.split("yucli> ").length - 1;
    async function line(text: string) {
      const before = prompts();
      child.stdin.write(`${text}\n`);
      await waitFor(() => prompts() > before);
    }
    return { child, done, waitFor, line, prompts, out: () => stdout, err: () => stderr };
  }

  it("连续两轮携带完整历史，命令/空行不请求；clear 后丢弃历史", async () => {
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    await ctx.line("first");
    await ctx.line("second");
    expect(requests[1]).toEqual({ model: "deepseek-v4-flash", messages: [
      { role: "user", content: "first" }, { role: "assistant", content: "ok" }, { role: "user", content: "second" },
    ], stream: true, tools: expect.any(Array) });
    await ctx.line("/help");
    await ctx.line("");
    expect(requests).toHaveLength(2);
    await ctx.line("/clear");
    await ctx.line("third");
    expect(requests[2]?.messages).toEqual([{ role: "user", content: "third" }]);
    ctx.child.stdin.write("/exit\n");
    expect(await ctx.done).toBe(0);
    expect(ctx.err()).toContain("新会话：");
    expect(ctx.out()).not.toMatch(/fake-key|data:|tool_calls|reasoning/u);
  });

  it.each(["/quit\n", ""])("quit/EOF 退出 0：%j", async (input) => {
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    ctx.child.stdin.end(input);
    expect(await ctx.done).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("管道连续输入在 EOF 前完整处理，turn 执行中不并发启动新问题", async () => {
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    ctx.child.stdin.end("first\nsecond\n");
    expect(await ctx.done).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toHaveLength(3);
  });

  it("保留最近 20 完整 turn，整体丢弃带工具调用的最旧 turn", async () => {
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    await ctx.line("read");
    for (let i = 0; i < 21; i++) await ctx.line(`turn-${i}`);
    const last = requests.at(-1)!;
    expect(last.messages).toHaveLength(41);
    expect(last.messages[0]).toEqual({ role: "user", content: "turn-0" });
    expect(last.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(last.messages.filter((m) => m.role === "user")).toHaveLength(21);
    ctx.child.stdin.write("/exit\n");
    expect(await ctx.done).toBe(0);
  });

  it.each(["fail", "timeout"])("%s 保留部分屏幕文本，失败 turn 不提交历史，下一轮可用", async (kind) => {
    const ctx = launch([], "60");
    await ctx.waitFor(() => ctx.prompts() === 1);
    await ctx.line("good");
    await ctx.line(kind === "fail" ? "fail" : "hang");
    expect(ctx.err()).not.toBe("");
    expect(ctx.out()).toContain("partial\nyucli> ");
    await ctx.line("next");
    expect(requests.at(-1)?.messages).toEqual([
      { role: "user", content: "good" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" },
    ]);
    ctx.child.stdin.write("/exit\n");
    expect(await ctx.done).toBe(0);
  });

  it("活跃 SIGINT 取消并恢复提示，半截 turn 不提交；闲置 SIGINT 退出 130", async () => {
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    ctx.child.stdin.write("hang\n");
    await ctx.waitFor(() => ctx.out().includes("partial"));
    ctx.child.kill("SIGINT");
    await ctx.waitFor(() => ctx.prompts() === 2);
    expect(ctx.err()).toContain("取消");
    await ctx.line("next");
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "next" }]);
    ctx.child.kill("SIGINT");
    expect(await ctx.done).toBe(130);
  });

  it("单次模式 SIGINT 返回 4，部分文本换行且仅在 stderr 输出取消", async () => {
    const ctx = launch(["--prompt", "hang"]);
    await ctx.waitFor(() => ctx.out().includes("partial"));
    ctx.child.kill("SIGINT");
    expect(await ctx.done).toBe(4);
    expect(ctx.out()).toBe("partial\n");
    expect(ctx.err()).toContain("取消");
  });
  it("D07 管道预送多问题，首次 assistant 保存故障后不发后续请求，退出 5", async () => {
    const ctx = launch(); await ctx.waitFor(() => ctx.prompts() === 1);
    ctx.child.stdin.end("save-fail\nsecond\nthird\n");
    expect(await ctx.done).toBe(5); expect(requests).toHaveLength(1); expect(ctx.err()).toContain("ownership_lost");
    expect(ctx.err()).not.toContain(cwd); expect(ctx.err()).not.toContain("fake-key");
  });

  it("首次 create 失败停止消费预送行，退出 5 且无模型请求", async () => {
    await mkdir(join(cwd, ".yucli"), { mode: 0o755 });
    const ctx = launch(); await ctx.waitFor(() => ctx.prompts() === 1); ctx.child.stdin.end("first\nsecond\n");
    expect(await ctx.done).toBe(5); expect(requests).toHaveLength(0);
  });

  it("A07/A10 非 TTY resume 命令不吃下一问题，new 保留旧文件", async () => {
    const ctx = launch(); await ctx.waitFor(() => ctx.prompts() === 1);
    await ctx.line("first"); await ctx.line("/resume"); await ctx.line("next"); await ctx.line("/new"); await ctx.line("fresh");
    ctx.child.stdin.end("/quit\n"); expect(await ctx.done).toBe(0);
    expect(requests).toHaveLength(3); expect(requests[1]?.messages).toHaveLength(3); expect(requests[2]?.messages).toHaveLength(1);
    expect(await readdir(join(cwd, ".yucli", "sessions"))).toHaveLength(2);
  });

});
