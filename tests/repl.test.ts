import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, toolCompletion } from "./helpers.js";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";

const source = fileURLToPath(new URL("../src/bootstrap/cli.ts", import.meta.url));
const built = fileURLToPath(new URL("../dist/bootstrap/cli.js", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const observer = fileURLToPath(new URL("./fixtures/repl-observer-preload.ts", import.meta.url));
type WireMessage = { role: string; content?: string; tool_call_id?: string; tool_calls?: { id: string }[] };

describe.each(["source", "built"])("REPL/流式信号 %s 子进程", (mode) => {
  let cwd: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  let requests: { messages: WireMessage[]; stream: boolean }[];
  const children: { child: ChildProcessWithoutNullStreams; done: Promise<number | null> }[] = [];
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
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    // 发送 SIGKILL 只提出终止请求；等真实 close 后再删除正文/锁，失败用例也不遗留写入者。
    await Promise.all(children.map(({ done }) => done));
    children.length = 0;
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  function launch(args: string[] = [], holdCancellation = false) {
    const child = spawn(process.execPath, [...(mode === "source" ? ["--import", tsx] : []), "--import", observer, mode === "source" ? source : built, ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: cwd, OPENCODE_GO_API_KEY: "fake-key", OPENCODE_GO_BASE_URL: server.baseUrl,
        YUCLI_REQUEST_TIMEOUT_MS: "2000", YUCLI_TEST_TARGET: mode,
        ...(holdCancellation ? { YUCLI_TEST_HOLD_CANCEL: "1", YUCLI_TEST_HOLD_END_SYNC: "1" } : {}) }, stdio: ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams; // 三条标准流显式为 pipe；IPC 不改变它们的非空保证。
    let stdout = "";
    let stderr = "";
    const changes = new EventEmitter();
    const stages: { stage: string; id: number; ms: number }[] = [];
    child.on("message", (stage: typeof stages[number]) => { stages.push(stage); changes.emit("change"); });
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; changes.emit("change"); });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; changes.emit("change"); });
    const done = new Promise<number | null>((resolve, reject) => {
      child.on("close", (code) => { changes.emit("change"); resolve(code); });
      child.on("error", reject);
    });
    void done.catch(() => {});
    children.push({ child, done });
    function waitFor(predicate: () => boolean, until = performance.now() + 4000): Promise<void> {
      if (predicate()) return Promise.resolve();
      // 输出、IPC 和实际退出都用事件唤醒；同一取消流程可复用一个4秒绝对截止点，不轮询或重置期限。
      return new Promise((resolve, reject) => {
        const check = () => { if (predicate()) { clearTimeout(timer); changes.removeListener("change", check); resolve(); } };
        const timer = setTimeout(() => {
          changes.removeListener("change", check);
          // 附诊断只在截止后运行，不把额外的磁盘读取算成“继续等待下一提示”。
          void (async () => {
            const names = await readdir(join(cwd, ".yucli", "sessions")).catch(() => []);
            const records = await Promise.all(names.map(async (name) => {
              const bytes = await readFile(join(cwd, ".yucli", "sessions", name), "utf8");
              return bytes.trimEnd().split("\n").map((line) => {
                try { const row = JSON.parse(line); return { seq: row.seq, type: row.type, role: row.payload?.role, outcome: row.payload?.outcome }; }
                catch { return { type: "incomplete_record" }; }
              });
            }));
            reject(new Error(`child observation timed out: prompts ${prompts()} / cancellation ${stderr.includes("取消")} / exit ${child.exitCode}/${child.signalCode} / observed-prefix ${JSON.stringify(records)} / stages ${JSON.stringify(stages)}`));
          })().catch(reject);
        }, Math.max(0, until - performance.now()));
        changes.on("change", check);
        check();
      });
    }
    const prompts = () => stdout.split("yucli> ").length - 1;
    async function line(text: string) {
      const before = prompts();
      child.stdin.write(`${text}\n`);
      await waitFor(() => prompts() > before);
    }
    return { child, done, waitFor, line, prompts, out: () => stdout, err: () => stderr, stages };
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
    // 协议失败与请求期限分开验证；正常 good/next 不能共用原来的 60 ms 竞速预算。
    // timeout 用真实挂起的响应等待本文件共用的 2000 ms 期限，不延长 4 秒观察 watchdog。
    const ctx = launch();
    await ctx.waitFor(() => ctx.prompts() === 1);
    await ctx.line("good");
    expect(ctx.out()).toContain("ok\nyucli> ");
    expect(ctx.err()).not.toMatch(/超时|缺少 message end/u);
    await ctx.line(kind === "fail" ? "fail" : "hang");
    const expectedError = kind === "fail" ? "流式响应缺少 message end。" : "模型请求超时（2000 ms）。";
    // stdout/stderr 是两条独立管道，下一提示到达不保证安全错误文本也已被父进程读到。
    await ctx.waitFor(() => ctx.err().includes(expectedError));
    expect(ctx.out()).toContain("partial\nyucli> ");
    await ctx.line("next");
    expect(requests.at(-1)?.messages).toEqual([
      { role: "user", content: "good" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" },
    ]);
    ctx.child.stdin.write("/exit\n");
    expect(await ctx.done).toBe(0);
    const names = await readdir(join(cwd, ".yucli", "sessions"));
    const rows = (await readFile(join(cwd, ".yucli", "sessions", names[0]!), "utf8"))
      .trimEnd().split("\n").map((line) => JSON.parse(line) as { type: string; payload: unknown });
    expect(rows.filter((row) => row.type === "turn_end").map((row) => row.payload)).toEqual([
      { outcome: "success" },
      { outcome: kind === "fail" ? "failed" : "timeout", error: {
        category: kind === "fail" ? "model" : "timeout",
        code: kind === "fail" ? "invalid_response" : "request_timeout",
        message: kind === "fail" ? "模型响应不符合契约。" : "模型请求超时。",
      } },
      { outcome: "success" },
    ]);
  });

  it("活跃 SIGINT 取消并恢复提示，半截 turn 不提交；闲置 SIGINT 退出 130", async () => {
    const ctx = launch([], true);
    await ctx.waitFor(() => ctx.prompts() === 1);
    ctx.child.stdin.write("hang\n");
    await ctx.waitFor(() => ctx.out().includes("partial"));
    const until = performance.now() + 4000;
    ctx.child.kill("SIGINT");
    await ctx.waitFor(() => ctx.stages.some((item) => item.stage === "turn_end_sync:held"), until);
    // 真实取消已传到网络，原 fsync 也完成，但尚未交付保存确认；这时不得出现下一提示或提前关锁。
    expect(ctx.stages.map((item) => item.stage)).toEqual(expect.arrayContaining(["signal:received", "fetch:abort", "stream:settled"]));
    expect(ctx.prompts()).toBe(1);
    expect(ctx.err()).not.toContain("取消");
    const names = await readdir(join(cwd, ".yucli", "sessions"));
    const rows = (await readFile(join(cwd, ".yucli", "sessions", names[0]!), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ seq: 2, type: "turn_end", payload: { outcome: "cancelled" } });
    const locks = new SessionLockAdapter({ storageRoot: join(cwd, ".yucli") });
    expect(await locks.probe(rows[0].sessionId)).toBe("busy");
    expect(ctx.stages.some((item) => item.stage === "writer_close:start")).toBe(false);
    ctx.child.send({ release: "end_sync" });
    // 明确构造 stdout 先到、stderr 后到；不靠负载或固定 sleep 碰运气复现管道乱序。
    await ctx.waitFor(() => ctx.prompts() === 2 && ctx.stages.some((item) => item.stage === "stderr:held"), until);
    expect(ctx.err()).not.toContain("取消");
    ctx.child.send({ release: "cancel_notice" });
    await ctx.waitFor(() => ctx.prompts() === 2 && ctx.err().includes("取消"), until);
    expect(ctx.err()).toContain("取消");
    const cancelledTimeline = ctx.stages.map((item) => item.stage);
    const endConfirmed = cancelledTimeline.indexOf("fact:turn_end:cancelled:fulfilled");
    expect(endConfirmed).toBeGreaterThan(cancelledTimeline.indexOf("stream:settled"));
    expect(endConfirmed).toBeLessThan(cancelledTimeline.lastIndexOf("prompt:issued"));
    expect(cancelledTimeline.indexOf("stderr:cancel_notice")).toBeGreaterThan(endConfirmed);
    await ctx.line("next");
    expect(requests.at(-1)?.messages).toEqual([{ role: "user", content: "next" }]);
    ctx.child.kill("SIGINT");
    expect(await ctx.done).toBe(130);
    expect(await locks.probe(rows[0].sessionId)).toBe("available");
    const timeline = ctx.stages.map((item) => item.stage);
    expect(timeline.lastIndexOf("close:fulfilled")).toBeLessThan(timeline.indexOf("lock_release:start"));
    expect(timeline).toContain("lock_release:fulfilled");
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
