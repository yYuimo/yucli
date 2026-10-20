#!/usr/bin/env node
/** bootstrap 组合根：解析模式、加载配置并注入真实客户端和只读工具，不保存模型原始响应。 */
import { Command, CommanderError } from "commander";
import { RegisteredTools } from "../core/toolRegistry.js";
import { ReadFileTool } from "../adapters/filesystem/ReadFileTool.js";
import { loadConfig } from "../adapters/config/loadConfig.js";
import { OpenCodeGoClient } from "../adapters/opencode-go/OpenCodeGoClient.js";
import { displayTurn, reportError } from "./output.js";
import { runRepl } from "./repl.js";

/**
 * 启动 CLI：有 --prompt 时完成单次流式 turn，无参数时运行 REPL。
 * 顶层 await 调用，无参数；输入来自 process.argv，输出通过 stdout/stderr。
 * 先解析帮助/版本和参数，再读取配置，确保用法错误不触发 .env 或网络访问。
 * 返回 Promise<void>，正常退出 0；用法 2、配置 3、单次模型/取消 4、意外错误 1。
 * REPL 闲置取消退出 130；活跃取消由 REPL 放弃当前 turn 后继续输入。
 * 间接发起网络和只读文件操作，不保存会话；信号监听在对应模式结束时清理。
 */
async function main(): Promise<void> {
  // 1. Commander 只处理终端参数，不在这些配置方法里加载密钥或创建网络连接。
  // exitOverride 将帮助/参数错误也转成异常，留给本入口统一决定退出码。
  const program = new Command()
    .name("yucli")
    .version("0.1.0")
    .description("流式只读文件问答；无 --prompt 进入 REPL。配置来自当前目录 .env 或进程环境变量。")
    .option("--prompt <text>", "发送一次问题，流式显示回答后退出")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ outputError: () => undefined });
  program.addHelpText("before", `${program.name()} ${program.version()}`);
  program.addHelpText("after", "\nREPL：/exit /quit 退出，/clear 清空历史，/help 帮助。\nCtrl+C：请求中取消当前轮；等待输入时退出 130；单次模式取消退出 4。\n");

  try {
    // 2. 帮助、版本和格式错误在这里先结束，后面的 loadConfig 不会因此执行。
    program.parse(process.argv);

    // ? 表示未传 --prompt 时字段不存在；不能以真假值代替是否提供参数的判断。
    const { prompt } = program.opts<{ prompt?: string }>();

    // 用户显式提供空白 prompt 是参数错误；完全没提供 prompt 则是合法的 REPL 入口。
    if (prompt !== undefined && !prompt.trim()) {
      process.stderr.write("参数错误：--prompt 不能是空白文本。\n");
      process.exitCode = 2;
      return;
    }

    // 3. 解析通过后再加载配置并组装依赖。read_file 的工作区由启动 cwd 固定，
    // 模型只看到工具定义，不能通过参数改变工具对象保存的根目录。
    const config = loadConfig();
    const client = new OpenCodeGoClient(config);
    const registry = new RegisteredTools([new ReadFileTool(process.cwd())]);

    // 4. 无 prompt 的分支把输入和历史生命周期交给 REPL；返回后立刻结束 main，
    // 防止继续落入下方单次模式，再额外发起一轮请求。
    if (prompt === undefined) {
      process.exitCode = await runRepl(client, registry, config.model);
      return;
    }

    // 5. 单次模式从空历史开始；整个 turn 共用控制器，因此 Ctrl+C 可跨多次工具往返取消。
    const controller = new AbortController();

    /** 单次模式 SIGINT 转成 turn 取消；displayTurn 抛 AbortError 后统一映射退出码 4。 */
    const onInterrupt = () => controller.abort();
    process.on("SIGINT", onInterrupt);
    try {
      await displayTurn(client, registry, config.model, [], prompt, controller.signal);
    } finally {
      // 模型成功/失败/取消均移除单次模式监听，避免已结束请求的控制器继续响应信号。
      process.removeListener("SIGINT", onInterrupt);
    }
  } catch (error) {
    // 6. Commander 的正常帮助输出也会走 catch，exitCode=0 时无需再打印错误。
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      process.stderr.write(`${error.message}\n${program.helpInformation()}`);
      process.exitCode = 2;
    } else process.exitCode = reportError(error);
  }

  // 只设置 exitCode，让 Node 在资源清理完成后自然退出，不用 process.exit 截断输出。
}

await main();
