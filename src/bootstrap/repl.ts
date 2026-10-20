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
  // 1. readline 把终端或管道输入切成行；只有真实 TTY 才启用终端编辑行为。
  // 同一套循环也能处理测试中的 stdin 管道，不需要两套 REPL 实现。
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });

  // 外层数组的一项就是一个完整 turn，内层是该 turn 的全部 user/assistant/tool 消息。
  // 这样裁剪时删除一整组，不会留下没有对应 assistant 调用的孤立 tool 消息。
  let turns: (readonly Message[])[] = [];

  // active 存在表示正在执行 turn；undefined 表示等待输入，Ctrl+C 的含义依此区分。
  // stopped 用于阻止继续处理输入，closed 表示输入源已经结束，两者不是模型成功标记。
  let active: AbortController | undefined;
  let stopped = false;
  let closed = false;
  let exitCode = 0;

  /**
   * 响应进程 SIGINT 或 readline 的终端 Ctrl+C：活跃时取消 turn，闲置时退出 130。
   * 无返回值，不提交消息；关闭输入会使等待中的异步迭代自然结束。
   */
  const onInterrupt = () => {
    // 活跃时只发出取消信号，由模型/工具各层检查并清理；不关闭 REPL 输入。
    if (active) active.abort();
    else {
      // 闲置时没有要取消的 turn，关闭 readline，使 for await 结束并返回退出码 130。
      stopped = true;
      exitCode = 130;
      input.close();
    }
  };

  /** 记录输入 EOF/close，避免 turn 完成后对已关闭的输入重复显示提示；不提交或清空历史。 */
  const onClose = () => { closed = true; };

  // 进程收到的 SIGINT 和终端 readline 发出的 SIGINT 共用处理函数；
  // 保存同一函数引用，退出时才能准确移除监听，不影响进程中其他监听器。
  input.on("close", onClose);
  process.on("SIGINT", onInterrupt);
  input.on("SIGINT", onInterrupt);
  input.setPrompt("yucli> ");
  try {
    input.prompt();

    // 2. 命令比较用 trim 后的副本，普通问题仍传入原始 line，保留用户的首尾空格。
    // 异步迭代一次只处理一行；下一次迭代发生在当前 displayTurn 完成之后。
    for await (const line of input) {
      if (stopped) break;
      const command = line.trim();

      // 内置命令不调用模型；空行也不会进入 else if (command) 分支。
      // /clear 只替换内存历史，不重新加载配置或重新创建客户端。
      if (command === "/exit" || command === "/quit") break;
      if (command === "/clear") turns = [];
      else if (command === "/help") process.stdout.write("/exit /quit：退出；/clear：清空历史；/help：帮助。\n");
      else if (command) {
        // 3. 每个 turn 都创建新控制器。被取消的 AbortSignal 不能重置或给下一轮复用。
        active = new AbortController();
        try {
          // flat 将完整 turn 组展开成有序消息快照，仅供 core 构造本轮请求。
          // await 失败会直接进入 catch，下面的历史赋值不会发生。
          const result = await displayTurn(client, registry, model, turns.flat(), line, active.signal);

          // 4. 唯一的历史提交点：成功后添加整组新增消息，再保留最后 20 组。
          // 当前 turn 的中间工具往返不单独计为一轮，也不会在流未完成时提前提交。
          turns = [...turns, result.appendedMessages].slice(-20);
        } catch (error) {
          // 错误只显示状态，已有 turns 保持原样；这里不把单轮失败变成进程退出码 4。
          reportError(error);
        } finally {
          // 成功、失败和取消都恢复闲置状态，下一次 Ctrl+C 才会按“等待输入”处理。
          active = undefined;
        }
      }

      // 5. turn 期间可能已经收到 EOF。已关闭输入时不额外显示一个无法回答的提示符。
      if (!closed) input.prompt();
    }
    return exitCode;
  } finally {
    // 6. /exit、EOF、闲置中断或异常都会走这里。关闭输入并解除监听，
    // 避免进程结束后仍保留 readline 资源或重复处理下一次 SIGINT。
    process.removeListener("SIGINT", onInterrupt);
    input.removeListener("SIGINT", onInterrupt);
    input.removeListener("close", onClose);
    input.close();
  }
}
