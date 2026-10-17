import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completion, readJson, startServer } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const apiKey = "cli-test-secret";

describe("CLI 子进程接线与退出码", () => {
  let cwd: string;
  let hits: number;
  let captured: unknown;
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "yucli-cli-"));
    hits = 0;
    server = await startServer(async (req, res) => {
      hits++;
      captured = await readJson(req);
      const messages = (captured as { messages: { content: string }[] }).messages;
      if (messages[0]?.content === "fail") {
        res.writeHead(401);
        res.end(`Authorization: Bearer ${apiKey}`);
      } else if (messages[0]?.content === "invalid-json") {
        res.end("invalid");
      } else {
        res.end(JSON.stringify(completion("CLI 回答")));
      }
    });
  });
  afterEach(async () => {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  });

  async function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    // 子进程不继承本机真实模型凭证，始终只使用临时目录与本地服务。
    const child = spawn(process.execPath, ["--import", tsxPath, cliPath, ...args], {
      cwd,
      env: { PATH: process.env.PATH, OPENCODE_GO_API_KEY: apiKey, OPENCODE_GO_BASE_URL: server.baseUrl, ...overrides },
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
    expect(captured).toEqual({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "你好" }], stream: false });
    expect(hits).toBe(1);
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

  it.each([[], ["--prompt"], ["--prompt", "   "], ["--unknown"], ["--prompt", "hi", "extra"]])("参数错误 %j 返回 2 且不发请求", async (...args: string[]) => {
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

  it.each(["fail", "invalid-json"])("模型错误 %s 只写 stderr，返回 4", async (prompt) => {
    const result = await run(["--prompt", prompt]);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(apiKey);
    expect(result.stderr).not.toContain("Bearer");
    expect(result.stderr).not.toBe("");
  });
});
