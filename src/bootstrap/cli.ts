#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { runPrompt } from "../core/runPrompt.js";
import { loadConfig } from "../adapters/config/loadConfig.js";
import { AbortError, ConfigError, RequestError, ResponseError } from "../contracts/llm-client.js";
import { OpenCodeGoClient } from "../adapters/opencode-go/OpenCodeGoClient.js";

async function main(): Promise<void> {
  const program = new Command()
    .name("yucli")
    .version("0.1.0")
    .description("单次模型问答；当前阶段不支持交互 REPL。配置来自当前目录 .env 或进程环境变量。")
    .requiredOption("--prompt <text>", "发送一次问题并输出模型回答")
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ outputError: () => undefined });
  program.addHelpText("before", `${program.name()} ${program.version()}`);

  try {
    program.parse(process.argv);
    const { prompt } = program.opts<{ prompt: string }>();
    if (!prompt.trim()) {
      process.stderr.write("参数错误：--prompt 不能是空白文本。\n");
      process.exitCode = 2;
      return;
    }
    const config = loadConfig();
    const result = await runPrompt(new OpenCodeGoClient(config), config.model, prompt);
    process.stdout.write(`${result.message.content}\n`);
  } catch (error) {
    if (error instanceof CommanderError) {
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
      process.stderr.write("程序发生未预期错误。\n");
      process.exitCode = 1;
    }
  }
}

await main();
