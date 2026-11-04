/** core 层持久化 turn 协调：唯一拥有 user/turn_end，不接触文件、计时器或进程退出。 */
import { AbortError, AgentLoopError, RequestError, ResponseError } from "../contracts/llm-client.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { Message } from "../contracts/message.js";
import { PersistenceError } from "../contracts/session.js";
import type { CommittedTurnResult, FailureEnd, RuntimeProfile, SessionWriter, TurnEnd } from "../contracts/session.js";
import { ToolExecutionError } from "../contracts/tool.js";
import type { ToolRegistry } from "../contracts/tool.js";
import { runTurnStream } from "./runTurnStream.js";

/** 调用方组装的一轮持久化业务输入；身份和已恢复历史由外部提供，不是存储或模型配置。 */
export interface PersistentTurnInput {
  /** 已就绪且持锁的保存能力；每个屏障必须 await，不传业务取消 signal。 */
  writer: SessionWriter;
  /** 外部提供的新身份，不可复用已落盘 turnId。 */
  turnId: string;
  /** user 外层的非敏感 provider/model 摘要，不放入模型消息。 */
  runtimeProfile: RuntimeProfile;
  /** 注入模型与工具能力，core 不创建提供方或文件 adapter。 */
  client: LlmClient;
  /** 名称分派及工具定义能力；逐项事实交付仍复用 T6 执行器。 */
  registry: ToolRegistry;
  /** 本轮实际模型标识，按原流式调用契约传递。 */
  model: string;
  /** 已提交的旧历史，只读使用；失败或保存未确认时不得修改。 */
  history: readonly Message[];
  /** 已接受的用户原文，先保存后请求模型。 */
  prompt: string;
  /** 即时文本显示回调；显示不等于历史提交。 */
  onText: (text: string) => void;
  /** 覆盖业务执行，不用于终止事实的保存；固定 outcome 后的新取消不再改写它。 */
  signal?: AbortSignal;
}

/**
 * 将业务异常映射为规格定义的安全终止数据，由协调方在执行失败时调用。
 * 全部摘要固定，不复制 error.message/responseSummary/stack；HTTP 状态仅保留合法整数。
 * 返回新的 FailureEnd，不保存原始异常；PersistenceError 在调用本函数前已分流。
 */
function failureEnd(error: unknown): FailureEnd {
  // 模型请求分类只使用稳定 code；服务返回的响应摘要即便已脱敏，也不重复写入日志。
  if (error instanceof RequestError) {
    if (error.code === "timeout") return { outcome: "timeout", error: { category: "timeout", code: "request_timeout", message: "模型请求超时。" } };
    if (error.code === "network" || error.code === "http") return {
      outcome: "failed", error: {
        category: "model", code: error.code, message: error.code === "network" ? "模型网络请求失败。" : "模型服务返回错误状态。",
        ...(error.code === "http" && Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? { httpStatus: error.status! } : {}),
      },
    };
  }
  // 其余已知业务错误各自对应唯一配对；取消不会覆盖已经发生的其他业务失败。
  if (error instanceof ResponseError) return { outcome: "failed", error: { category: "model", code: "invalid_response", message: "模型响应不符合契约。" } };
  if (error instanceof AgentLoopError && (error.code === "protocol_error" || error.code === "loop_limit")) return {
    outcome: "failed", error: { category: error.code === "protocol_error" ? "protocol" : "limit", code: error.code, message: error.code === "protocol_error" ? "模型工具调用不符合协议。" : "已达到模型调用次数上限。" },
  };
  if (error instanceof ToolExecutionError) return { outcome: "failed", error: { category: "tool", code: "tool_execution_failed", message: "工具执行发生内部错误。" } };
  if (error instanceof AbortError) return { outcome: "cancelled", error: { category: "cancellation", code: "user_interrupt", message: "本轮执行已取消。" } };
  // unknown 可能包含任意原文/路径或根本不是 Error，始终用固定摘要，原值只用于向调用方重抛。
  return { outcome: "failed", error: { category: "internal", code: "internal_error", message: "本轮执行发生内部错误。" } };
}

/**
 * 保存 user 后运行 T6 流式执行，再保存唯一 turn_end；由未来持久化入口调用。
 * 输入身份、摘要及执行能力来自调用方；仅成功终止保存确认后返回 CommittedTurnResult。
 * 业务失败在保存安全终止后重抛原异常；任何 PersistenceError 原样穿透且不递归终止或重试。
 * 不修改旧 history，不生成身份，不关闭资源；存储故障收尾由 bootstrap 监督负责。
 */
export async function runPersistentTurn(input: PersistentTurnInput): Promise<CommittedTurnResult> {
  const { writer, turnId, client, registry, model, history, prompt, onText, signal } = input;
  // user 保存放在业务 catch 之外；未确认的 user 不能触发模型或补写 turn_end。
  await writer.appendDurable({ type: "user", turnId, runtimeProfile: input.runtimeProfile, message: { role: "user", content: prompt } });
  let result: CommittedTurnResult["result"] | undefined;
  let cause: unknown;
  let failed = false;
  let end: TurnEnd;
  try {
    result = await runTurnStream(client, registry, model, history, prompt, onText, {}, signal, {
      turnId, facts: {
        /** T6 的顺序屏障只桥接 writer；不附加取消、重试、转换或资源收尾。 */
        async record(fact) { await writer.appendDurable(fact); },
      },
    });
    // 最终 assistant 保存期间仍可能取消；在固定终止原因前最后观察一次。
    if (signal?.aborted) throw new AbortError("本轮执行已取消。");
    end = { outcome: "success" };
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    failed = true; // unknown 甚至可以为 undefined，不能用 cause 是否有值判断失败。
    cause = error;
    end = failureEnd(error);
  }
  // 这里是唯一终止交付点，已固定 outcome；等待期间的取消不能写第二条终止。
  // 保存拒绝不进入上面的业务 catch，直接交付原 PersistenceError，不返回凭证。
  await writer.appendDurable({ type: "turn_end", turnId, end });
  if (failed) throw cause;
  // 此分支必然经历了 runTurnStream 的完整成功返回；! 仅向 TS 说明上述控制流保证，不新增运行时校验。
  return { status: "committed", turnId, result: result! };
}
