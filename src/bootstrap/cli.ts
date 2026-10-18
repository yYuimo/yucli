#!/usr/bin/env node
// bootstrap 是组合根：认识具体 adapter，创建对象后将它注入 core。
// 顶部 shebang 让系统知道用 Node 运行脚本；本项目是 ESM，可用顶层 await。
import { Command, CommanderError } from "commander";
import { runPrompt } from "../core/runPrompt.js";
import { loadConfig } from "../adapters/config/loadConfig.js";
import { AbortError, ConfigError, RequestError, ResponseError } from "../contracts/llm-client.js";
import { OpenCodeGoClient } from "../adapters/opencode-go/OpenCodeGoClient.js";

/**
 * 执行一次终端问答：读取 --prompt、加载配置、创建客户端、调用模型并输出结果。
 * 文件末尾的 await main() 是唯一启动调用；命令行输入来自 process.argv，无函数参数。
 * --help/--version 输出后结束，参数不合法时不加载配置，也不请求模型。
 *
 * @returns Promise<void>，表示本次 CLI 工作结束；回答直接写到 stdout，不作为返回值。
 * 预期失败在本函数内捕获：错误写入 stderr，并设置退出码
 * 2（参数）、3（配置）、4（模型）；未分类错误设置为 1。正常情况退出码为 0。
 * 本函数会间接读取 .env 并发起模型请求，但不会保存消息历史或直接强制退出进程。
 */
async function main(): Promise<void> {
  // 链式调用：Commander 的配置方法返回命令对象，可以继续调用下一个方法。
  const program = new Command()
    .name("yucli")
    .version("0.1.0")
    .description("单次模型问答；当前阶段不支持交互 REPL。配置来自当前目录 .env 或进程环境变量。")
    .requiredOption("--prompt <text>", "发送一次问题并输出模型回答")
    .allowExcessArguments(false)
    // Commander 默认可能直接结束进程；改为抛 CommanderError，由下方统一处理。
    .exitOverride()
    // 禁止 Commander 自动重复打印错误，下方 catch 负责输出错误和用法。
    .configureOutput({ outputError: () => undefined });
  program.addHelpText("before", `${program.name()} ${program.version()}`);

  try {
    // parse 会先检查参数；--help/--version 也在这里处理，不要求模型配置存在。
    program.parse(process.argv);
    // <{ prompt: string }> 是泛型参数，只声明 opts() 的结果形状；
    // 必填参数的运行时检查由 Commander 执行。{ prompt } 从对象中取出同名字段。
    const { prompt } = program.opts<{ prompt: string }>();
    if (!prompt.trim()) {
      // trim 只用于判断是否空白；实际发送时仍使用用户原文 prompt。
      process.stderr.write("参数错误：--prompt 不能是空白文本。\n");
      process.exitCode = 2;
      return;
    }
    const config = loadConfig();
    // 先创建客户端，再传入 core。await 等待 Promise 完成，失败会进入本层 catch。
    const result = await runPrompt(new OpenCodeGoClient(config), config.model, prompt);
    process.stdout.write(`${result.message.content}\n`);
  } catch (error) {
    // catch 的 error 是 unknown；instanceof 在运行时判断并收窄它的 TS 类型。
    // stdout 留给回答，stderr 用于错误，便于 shell 重定向或脚本消费。
    if (error instanceof CommanderError) {
      // exitOverride 也将正常帮助/版本输出转成异常，退出码 0 表示无需报错。
      if (error.exitCode === 0) return;
      process.stderr.write(`${error.message}\n${program.helpInformation()}`);
      process.exitCode = 2;
    } else if (error instanceof ConfigError) {
      process.stderr.write(`配置错误：${error.message}\n`);
      process.exitCode = 3;
    } else if (error instanceof RequestError || error instanceof ResponseError || error instanceof AbortError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 4;
    } else {
      // 未知异常不直接打印，避免底层对象或配置进入终端。
      process.stderr.write("程序发生未预期错误。\n");
      process.exitCode = 1;
    }
  }
  // 设置 exitCode 让 Node 在没有待处理任务时自然退出，不用 process.exit 强制截断输出。
}

// 顶层 await 让入口等待 main 完成；async 表示返回 Promise，不表示另开线程。
await main();
