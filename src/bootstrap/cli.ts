#!/usr/bin/env node
/** bootstrap 组合根：先分流用法，再组装配置/模型/真实存储；prompt 保持非持久化。 */
import { realpath } from "node:fs/promises";
import { CommanderError } from "commander";
import { RegisteredTools } from "../core/toolRegistry.js";
import { ReadFileTool } from "../adapters/filesystem/ReadFileTool.js";
import { loadConfig } from "../adapters/config/loadConfig.js";
import { OpenCodeGoClient } from "../adapters/opencode-go/OpenCodeGoClient.js";
import { SessionFileAdapter } from "../adapters/session/SessionFileAdapter.js";
import { SessionLockAdapter } from "../adapters/session/SessionLockAdapter.js";
import { displayTurn, reportError } from "./output.js";
import { cliCommand, cliMode } from "./cliOptions.js";
import { LineInput } from "./lineInput.js";
import { runSessionApp } from "./sessionApp.js";
import type { SessionRuntime } from "./repl.js";

/**
 * 解析进程参数后执行唯一模式；帮助/版本/用法/TTY 错误早于配置和会话访问。
 * 模型只请求启动配置，文件工具使用 cwd realpath；生产应急退出能力仅在此组合根注入。
 * 正常设置 exitCode 让资源自然收尾，只有故障监督 5 秒到期才允许 exit(5)。
 */
async function main(): Promise<void> {
  const program = cliCommand();
  try {
    program.parse(process.argv);
    const mode = cliMode(program);
    if (mode.type === "resume" && !mode.id && !(process.stdin.isTTY && process.stdout.isTTY)) {
      process.stderr.write("选择器需要 stdin/stdout 都是 TTY；请使用 --sessions 或 --resume <sessionId>。\n");
      process.exitCode = 2;
      return;
    }
    const cwd = await realpath(process.cwd());
    /** 需要写恢复或业务请求才调用，列表/选择器浏览不读取 .env，也不加载模型密钥。 */
    const runtime = (): SessionRuntime => {
      const config = loadConfig();
      return {
        client: new OpenCodeGoClient(config), registry: new RegisteredTools([new ReadFileTool(cwd)]),
        model: config.model, profile: { provider: "opencode-go", model: config.model },
      };
    };
    if (mode.type === "prompt") {
      const business = runtime();
      const controller = new AbortController();
      /** 单次模式取消只传业务 signal，不组装任何会话或锁资源。 */
      const interrupt = () => controller.abort();
      process.on("SIGINT", interrupt);
      try { await displayTurn(business.client, business.registry, business.model, [], mode.prompt, controller.signal); }
      finally { process.removeListener("SIGINT", interrupt); }
      return;
    }
    // 构造本身不创建目录/加载 native；只读列表也不会触发写入 preflight。
    const locks = new SessionLockAdapter();
    const store = new SessionFileAdapter({ locks });
    process.exitCode = await runSessionApp(mode, {
      store, cwd, runtime, preflight: () => locks.preflight(), input: () => new LineInput(),
      write: (text) => { process.stdout.write(text); }, error: (text) => { process.stderr.write(text); },
      exit: (code) => process.exit(code),
    });
  } catch (cause) {
    if (cause instanceof CommanderError) {
      if (cause.exitCode === 0) return;
      process.stderr.write(`${cause.message}\n${program.helpInformation()}`);
      process.exitCode = 2;
    } else process.exitCode = reportError(cause);
  }
}

await main();
