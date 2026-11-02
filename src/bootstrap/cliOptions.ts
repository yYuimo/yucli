/** bootstrap 的无副作用参数分流；在配置、会话读取及输入监听之前拒绝非法组合。 */
import { Command } from "commander";

/** 解析后的互斥入口；resume 缺少 id 表示 picker，all 只属于列表/picker。 */
export type CliMode =
  | { type: "prompt"; prompt: string }
  | { type: "sessions"; all: boolean }
  | { type: "resume"; id?: string; all: boolean }
  | { type: "continue" }
  | { type: "repl" };

/** 运行时安全 ID 校验，供 CLI/REPL 命令复用；不是文件存在性或写入授权检查。 */
export function isSessionId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value); }

/** 建立 Commander 实例；帮助/版本由调用方捕获正常退出，不读取环境配置或会话文件。 */
export function cliCommand(): Command {
  const program = new Command().name("yucli").version("0.1.0")
    .description("流式文件问答与持久化 REPL。配置来自当前目录 .env 或进程环境变量。")
    .option("--prompt <text>", "一次问题，不保存会话")
    .option("--sessions", "只读列出会话，显示完整 ID")
    .option("-c, --continue", "继续当前目录最近的非空会话")
    .option("-r, --resume [sessionId]", "按完整 ID 恢复；省略 ID 打开 TTY 选择器")
    .option("--all", "列表或选择器从全局范围开始")
    .allowExcessArguments(false).exitOverride().configureOutput({ outputError: () => undefined });
  program.addHelpText("before", "yucli 0.1.0");
  program.addHelpText("after", "\nREPL：/new（/clear 同义） /resume [ID|--all] /exit /quit /help。\nCtrl+C：请求中取消当前轮；等待输入时退出 130。\n");
  return program;
}

/**
 * Commander 完成基础解析后验证互斥/可选 ID/all；CLI 在任何配置或存储操作前调用。
 * 返回唯一入口；不合法则通过 Commander 用法异常交给组合根映射退出码 2。
 */
export function cliMode(program: Command): CliMode {
  const options = program.opts<{ prompt?: string; sessions?: boolean; continue?: boolean; resume?: string | true; all?: boolean }>();
  const count = [options.prompt, options.sessions, options.continue, options.resume].filter((item) => item !== undefined).length;
  if (count > 1) program.error("四种显式模式不能同时使用。");
  if (options.all && !options.sessions && options.resume !== true) program.error("--all 只允许搭配 --sessions 或无 ID 的 --resume。");
  if (options.prompt !== undefined) {
    if (!options.prompt.trim()) program.error("--prompt 不能是空白文本。");
    return { type: "prompt", prompt: options.prompt };
  }
  if (options.sessions) return { type: "sessions", all: Boolean(options.all) };
  if (options.continue) return { type: "continue" };
  if (options.resume !== undefined) {
    if (options.resume !== true && !isSessionId(options.resume)) program.error("sessionId 必须是完整的安全身份。");
    return { type: "resume", all: Boolean(options.all), ...(options.resume === true ? {} : { id: options.resume }) };
  }
  return { type: "repl" };
}
