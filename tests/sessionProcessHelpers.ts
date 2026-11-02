/** T9 真实 CLI 子进程测试工具：只接受显式临时 HOME/cwd、本地 SSE 和测试专用 preload。 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, toolCompletion } from "./helpers.js";

export type EntryMode = "source" | "built";
export const entryModes: EntryMode[] = ["source", "built"];
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/session-fault-preload.ts", import.meta.url));
const bridge = fileURLToPath(new URL("./fixtures/session-pty.py", import.meta.url));

/** 保留真实退出/信号、输出和 IPC 检查点；wait 由事件唤醒，不 sleep 猜测时序。 */
export class CliProcess {
  stdout = "";
  stderr = "";
  messages: { event: string; [key: string]: unknown }[] = [];
  pid: number | undefined;
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private ended = false;
  private readonly changes = new EventEmitter();

  /** 订阅一个已创建的 Node CLI 或 PTY bridge；PTY 通过 JSON 行控制真实终端。 */
  constructor(readonly child: ChildProcess, private readonly pty = false) {
    this.pid = child.pid;
    let buffer = "";
    child.stdout!.setEncoding("utf8").on("data", (text: string) => {
      if (!pty) this.stdout += text;
      else {
        buffer += text;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, index)) as { output?: string; pid?: number; code?: number; signal?: NodeJS.Signals };
          buffer = buffer.slice(index + 1);
          if (event.output !== undefined) this.stdout += event.output;
          if (event.pid !== undefined) this.pid = event.pid;
          if (event.code !== undefined || event.signal !== undefined) this.messages.push({ event: "pty_exit", ...event });
        }
      }
      this.changes.emit("change");
    });
    child.stderr!.setEncoding("utf8").on("data", (text: string) => { this.stderr += text; this.changes.emit("change"); });
    child.on("message", (message: { event: string; [key: string]: unknown }) => { this.messages.push(message); this.changes.emit("change"); });
    this.done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        this.ended = true;
        const ptyExit = this.messages.find((message) => message.event === "pty_exit");
        resolve(ptyExit ? { code: ptyExit.code as number | null ?? null, signal: ptyExit.signal as NodeJS.Signals | null ?? null } : { code, signal });
        this.changes.emit("change");
      });
    });
    void this.done.catch(() => {}); // 提前启动的等待也观察失败；断言仍 await 原 Promise。
  }

  /** 等输出/IPC/退出条件；截止时间只防测试挂死，不替代被测 30 秒/5 秒生产计时器。 */
  wait(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.changes.removeListener("change", check); if (error) reject(error); else resolve(); };
      const check = () => { if (predicate()) finish(); else if (this.ended) finish(new Error(`CLI exited before observation: ${this.stdout} / ${this.stderr}`)); };
      const timer = setTimeout(() => finish(new Error(`CLI observation timeout: ${this.stdout} / ${this.stderr}`)), timeoutMs);
      this.changes.on("change", check);
      check();
    });
  }

  /** 取得 preload 发出的真实故障边界；可晚于事件订阅，消息快照保留不会丢失。 */
  async checkpoint(event = "held") { await this.wait(() => this.messages.some((message) => message.event === event)); return this.messages.find((message) => message.event === event)!; }
  /** 仅发送终端/管道字节；调用方用输出、IPC 或 done 等待实际接受/保存完成。 */
  write(text: string) { this.child.stdin!.write(this.pty ? JSON.stringify({ input: text }) + "\n" : text); }
  /** 交付普通管道 EOF 或真实终端 Ctrl+D。 */
  end(text = "") { if (this.pty) { if (text) this.write(text); this.write("\x04"); } else this.child.stdin!.end(text); }
  /** 发 OS 信号给 CLI（PTY 中是实际 Node PID，不是 Python bridge）。 */
  signal(signal: NodeJS.Signals) { if (this.pid) process.kill(this.pid, signal); }
  /** 发送一行，等下一提示，适用于逐步 TTY/REPL 冒烟，不依赖固定 sleep。 */
  async line(text: string) { const before = this.prompts(); this.write(text + "\n"); await this.wait(() => this.prompts() > before); }
  /** 统计实际普通提示次数，picker 提示不混入普通问题循环。 */
  prompts() { return this.stdout.split("yucli> ").length - 1; }
  /** 测试失败时也终止真实 CLI 并等待内核释放，不留下持锁孤儿进程。 */
  async dispose() {
    if (!this.ended) {
      if (this.pty) this.child.stdin!.end();
      else this.child.kill("SIGKILL");
    }
    await this.done;
  }
}

/** 每个场景独立临时 home/repo/SSE；并发故障测试不共享全局状态或生产凭证。 */
export async function processSandbox() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t9-")));
  const home = join(directory, "home"); const cwd = join(directory, "repo");
  await mkdir(home); await mkdir(cwd);
  const requests: { model: string; messages: { role: string; content?: string }[] }[] = [];
  const children: CliProcess[] = [];
  const server = await startServer(async (req, res) => {
    const request = await readJson(req) as typeof requests[number]; requests.push(request);
    const prompt = request.messages.findLast((item) => item.role === "user")?.content;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (prompt === "hang") res.write(sseFrame(streamChunk({ content: "partial" })));
    else if (prompt === "fail") res.end(sseFrame(streamChunk({ content: "partial" })));
    else if (prompt === "read" && request.messages.at(-1)?.role === "user") res.end(completionSse(toolCompletion()));
    else res.end(completionSse(completion("ok")));
  });
  return {
    directory, home, cwd, root: join(home, ".yucli"), requests,
    /** 启动源码或新构建 CLI；可选故障 preload 只存在于 tests，生产没有相关环境开关。 */
    launch(mode: EntryMode, options: { args?: string[]; cwd?: string; fault?: string; pty?: boolean; ptySide?: "input" | "output"; key?: string; model?: string } = {}) {
      const entry = fileURLToPath(new URL(`../${mode === "source" ? "src/bootstrap/cli.ts" : "dist/bootstrap/cli.js"}`, import.meta.url));
      const args = ["--import", tsx, ...(options.fault ? ["--import", preload] : []), entry, ...(options.args ?? [])];
      const env = { PATH: process.env.PATH, HOME: home, OPENCODE_GO_API_KEY: options.key ?? "t9-local-key",
        OPENCODE_GO_BASE_URL: server.baseUrl, OPENCODE_GO_MODEL: options.model ?? "test-model", YUCLI_REQUEST_TIMEOUT_MS: "2000",
        ...(options.fault ? { YUCLI_TEST_TARGET: mode, YUCLI_TEST_FAULT: options.fault } : {}),
        ...(options.ptySide ? { YUCLI_TEST_PTY_SIDE: options.ptySide } : {}) };
      const child = options.pty
        ? spawn("python3", [bridge, process.execPath, ...args], { cwd: options.cwd ?? cwd, env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(process.execPath, args, { cwd: options.cwd ?? cwd, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
      const processHandle = new CliProcess(child, options.pty); children.push(processHandle); return processHandle;
    },
    /** 无论断言在哪一步失败，都先等待所有进程死亡，再删除临时目录。 */
    async dispose() { await Promise.all(children.map((child) => child.dispose())); await server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
