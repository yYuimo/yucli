import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { completion, completionSse, readJson, startServer, toolCompletion } from "./helpers.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin: { yucli: string } };
const sourceCli = fileURLToPath(new URL("../src/bootstrap/cli.ts", import.meta.url));
const builtCli = fileURLToPath(new URL(`../${packageJson.bin.yucli}`, import.meta.url));
const tsxPath = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const apiKey = "cli-test-secret";

describe.each(["source", "built"])("CLI %s 子进程接线与退出码", (mode) => {
  let cwd: string;
  let hits: number;
  let captured: unknown;
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "yucli-cli-"));
    hits = 0;
    await writeFile(join(cwd, "README.md"), "CLI 文件内容");
    server = await startServer(async (req, res) => {
      hits++;
      captured = await readJson(req);
      const messages = (captured as { messages: { content: string }[] }).messages;
      if (messages[0]?.content === "fail") {
        res.writeHead(401);
        res.end(`Authorization: Bearer ${apiKey}`);
      } else if (messages[0]?.content === "invalid-json") {
        res.end("invalid");
      } else if (messages[0]?.content === "loop-limit") {
        res.end(completionSse(toolCompletion()));
      } else if (messages[0]?.content === "bad-batch") {
        res.end(completionSse(toolCompletion([{ id: "valid" }, { id: "invalid", argumentsJson: "{" }])));
      } else if (messages[0]?.content === "truncated") {
        res.end(completionSse(toolCompletion(undefined, "length")));
      } else if (messages[0]?.content === "read" && hits === 1) {
        res.end(completionSse(toolCompletion(), { prompt_tokens: 2, completion_tokens: 3 }));
      } else {
        res.end(completionSse(completion("CLI 回答"), { prompt_tokens: 2, completion_tokens: 3 }));
      }
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    // 子进程不继承本机真实模型凭证，始终只使用临时目录与本地服务。
    const entry = mode === "source" ? ["--import", tsxPath, sourceCli] : [builtCli];
    const child = spawn(process.execPath, [...entry, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, OPENCODE_GO_API_KEY: apiKey, OPENCODE_GO_BASE_URL: server.baseUrl, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, stdout, stderr };
  }

  it("成功回答只写 stdout，返回 0", async () => {
    expect(await run(["--prompt", "你好"])).toEqual({ code: 0, stdout: "CLI 回答\n", stderr: "" });
    expect(captured).toEqual({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "你好" }], stream: true,
      tools: [{ type: "function", function: expect.objectContaining({ name: "read_file" }) }],
    });
    expect(hits).toBe(1);
  });

  it("工具往返后只输出最终回答，后续请求含调用与真实文件结果", async () => {
    expect(await run(["--prompt", "read"])).toEqual({ code: 0, stdout: "CLI 回答\n", stderr: "" });
    expect(hits).toBe(2);
    expect(captured).toMatchObject({ messages: [
      { role: "user", content: "read" },
      { role: "assistant", tool_calls: [expect.objectContaining({ id: "call-1" })] },
      { role: "tool", tool_call_id: "call-1", content: "CLI 文件内容" },
    ] });
  });

  it("help 不要求配置且不发请求", async () => {
    const result = await run(["--help"], { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--prompt");
    expect(result.stdout).toContain(".env");
    expect(result.stdout).toContain("yucli 0.1.0");
    expect(result.stderr).toBe("");
    expect(hits).toBe(0);
  });

  it.each([["--prompt"], ["--prompt", "   "], ["--unknown"], ["--prompt", "hi", "extra"]])("参数错误 %j 返回 2 且不发请求", async (...args: string[]) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(hits).toBe(0);
  });

  it("缺少 key 返回 3 且不发请求", async () => {
    const result = await run(["--prompt", "你好"], { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPENCODE_GO_API_KEY");
    expect(hits).toBe(0);
  });

  it.each(["fail", "invalid-json", "loop-limit", "bad-batch", "truncated"])("模型错误 %s 只写 stderr，返回 4", async (prompt) => {
    const result = await run(["--prompt", prompt]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(apiKey);
    expect(result.stderr).not.toContain("Bearer");
    expect(result.stderr).not.toBe("");
  });
  it.each([
    ["--all"], ["--continue", "id"], ["--continue", "--all"], ["--resume", "id", "--all"],
    ["--resume", ""], ["--resume", "../bad"], ["--sessions", "--prompt", "x"],
    ["--sessions", "--continue"], ["--sessions", "--resume"], ["--resume", "id", "extra"],
  ])("阶段 04 非法组合 %j 先于配置/存储返回 2", async (...args: string[]) => {
    const result = await run(args, { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(2); expect(hits).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  it.each([["--sessions"], ["--sessions", "--all"]])("%j 无密钥、只读空列表返回 0", async (...args: string[]) => {
    const result = await run(args, { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(0); expect(result.stdout).toContain("没有可恢复会话"); expect(result.stderr).toBe("");
    expect(hits).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  it("非 TTY picker 早于配置/存储返回 2 并给出替代入口", async () => {
    const result = await run(["--resume"], { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(2); expect(result.stderr).toContain("--sessions"); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  it("continue 无候选返回 5，不加载配置、不新建", async () => {
    const result = await run(["--continue"], { OPENCODE_GO_API_KEY: "" });
    expect(result.code).toBe(5); expect(result.stderr).toContain("not_found"); expect(hits).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  it("直接恢复配置错误为 3；配置合法但找不到 ID 为 5，不新建", async () => {
    expect((await run(["--resume", "missing"], { OPENCODE_GO_API_KEY: "" })).code).toBe(3);
    const result = await run(["-r", "missing"]); expect(result.code).toBe(5); expect(result.stderr).toContain("not_found");
    expect(hits).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  it("prompt 继续完全不持久化", async () => {
    expect((await run(["--prompt", "hello"])).code).toBe(0); expect(await readdir(cwd)).toEqual(["README.md"]);
  });

  async function stored(id = "full-copy-id") {
    const root = join(cwd, ".yucli"); await mkdir(join(root, "sessions"), { recursive: true, mode: 0o700 });
    const createdAt = "2026-10-29T00:00:00.000Z";
    const rows = [{ type: "session_meta", formatVersion: 1, sessionId: id, createdAt, cwd: await realpath(cwd) },
      { seq: 1, timestamp: createdAt, turnId: "old", type: "message", runtimeProfile: { provider: "opencode-go", model: "deepseek-v4-flash" }, payload: { role: "user", content: "old interrupted" } }];
    await writeFile(join(root, "sessions", `2026-10-29T00-00-00-000Z_${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    return root;
  }

  it("已有列表无密钥输出完整 ID；直接 ID 非 TTY 恢复 EOF 正常关闭", async () => {
    await stored(); const list = await run(["--sessions"], { OPENCODE_GO_API_KEY: "" });
    expect(list.code).toBe(0); expect(list.stdout).toContain("full-copy-id"); expect(list.stdout).not.toMatch(/runtimeProfile|Bearer|cli-test-secret/u);
    const resumed = await run(["--resume", "full-copy-id"]); expect(resumed.code).toBe(0); expect(resumed.stderr).toContain("恢复会话：full-copy-id"); expect(hits).toBe(0);
  });

  it("continue 最近目标真实 busy 返回 5，不回退、不新建", async () => {
    const root = await stored(); const lock = await new SessionLockAdapter({ storageRoot: root }).acquire("full-copy-id");
    try {
      const result = await run(["--continue"]); expect(result.code).toBe(5); expect(result.stderr).toContain("session_busy"); expect(hits).toBe(0);
      expect(await readdir(join(root, "sessions"))).toHaveLength(1);
    } finally { await lock.release(); }
  });

});
