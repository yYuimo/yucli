/** bootstrap 的输入与内存历史生命周期；只保存完整 turn，不持久化会话。 */
import { createInterface } from "node:readline";
import type { LlmClient } from "../contracts/llm-client.js";
import type { Message } from "../contracts/message.js";
import type { ToolRegistry } from "../contracts/tool.js";
import { displayTurn, reportError } from "./output.js";

/**
 * 连续读取普通问题或内置命令，供无 --prompt 的 CLI 调用。
 * client/registry/model 在启动时注入，配置与工作区整次进程保持一致。
 * 返回退出码：/exit、/quit、EOF 为 0，等待输入时 Ctrl+C 为 130；turn 失败后继续输入。
 * 每轮成功才保存完整消息组，最多最近 20 组；失败/取消不修改已有历史。
 * 活跃轮次 Ctrl+C 只取消当前控制器，闲置时关闭输入；finally 清理 readline 与信号监听。
 * 输入可由终端或管道提供；turn 期间不消费下一条输入命令，不显示原始协议和工具参数。
 */
export async function runRepl(client: LlmClient, registry: ToolRegistry, model: string): Promise<number> {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let turns: (readonly Message[])[] = [];
  let active: AbortController | undefined;
  let stopped = false;
  let closed = false;
  let exitCode = 0;

  /**
   * 响应进程 SIGINT 或 readline 的终端 Ctrl+C：活跃时取消 turn，闲置时退出 130。
   * 无返回值，不提交消息；关闭输入会使等待中的异步迭代自然结束。
   */
  const onInterrupt = () => {
    if (active) active.abort();
    else {
      stopped = true;
      exitCode = 130;
      input.close();
    }
  };
  /** 记录输入 EOF/close，避免 turn 完成后对已关闭的输入重复显示提示；不提交或清空历史。 */
  const onClose = () => { closed = true; };
  input.on("close", onClose);
  process.on("SIGINT", onInterrupt);
  input.on("SIGINT", onInterrupt);
  input.setPrompt("yucli> ");
  try {
    input.prompt();
    // 异步迭代一次只处理一行；下一次迭代发生在当前 displayTurn 完成之后。
    for await (const line of input) {
      if (stopped) break;
      const command = line.trim();
      if (command === "/exit" || command === "/quit") break;
      if (command === "/clear") turns = [];
      else if (command === "/help") process.stdout.write("/exit /quit：退出；/clear：清空历史；/help：帮助。\n");
      else if (command) {
        active = new AbortController();
        try {
          const result = await displayTurn(client, registry, model, turns.flat(), line, active.signal);
          turns = [...turns, result.appendedMessages].slice(-20);
        } catch (error) {
          reportError(error);
        } finally {
          active = undefined;
        }
      }
      if (!closed) input.prompt();
    }
    return exitCode;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    input.removeListener("SIGINT", onInterrupt);
    input.removeListener("close", onClose);
    input.close();
  }
}
