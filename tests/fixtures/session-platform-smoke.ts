/** T9 非目标平台/Node 的独立冒烟；不运行持久化正例，不跳过失败，不请求真实模型。 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completion, completionSse, startServer } from "../helpers.js";

const directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-platform-smoke-")));
const cli = fileURLToPath(new URL("../../dist/bootstrap/cli.js", import.meta.url));
let requests = 0;
const server = await startServer((_request, response) => { requests++; response.end(completionSse(completion("compatible"))); });

/** 用当前 Node 启动实际构建 CLI；同时设置 Windows/Unix home，禁止误入真实用户目录。 */
async function run(args: string[], configured = false) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
      OPENCODE_GO_API_KEY: configured ? "platform-local-key" : "", OPENCODE_GO_BASE_URL: server.baseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve); child.stdin.end();
  });
  return { code, stdout, stderr };
}

try {
  // 此脚本只用于未支持环境的反例门禁；目标环境必须执行完整 pnpm test，不能借此简化。
  assert.equal(process.platform === "darwin" && process.arch === "arm64" && process.versions.node === "24.14.0", false);
  for (const flag of ["--help", "--version"]) assert.equal((await run([flag])).code, 0);
  const prompt = await run(["--prompt", "hello"], true);
  assert.equal(prompt.code, 0); assert.equal(prompt.stdout, "compatible\n"); assert.equal(requests, 1);
  const persistent = await run([], true);
  assert.equal(persistent.code, 5); assert.match(persistent.stderr, /platform_unsupported/u);
  assert.equal(requests, 1); assert.deepEqual(await readdir(directory), []);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.versions.node,
    help: 0, version: 0, prompt: 0, persistence: 5, modelRequests: requests, storageEntries: 0 }));
} finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
