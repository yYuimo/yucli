import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/core/agentLoop.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { AbortError, AgentLoopError, RequestError, ResponseError } from "../src/contracts/llm-client.js";
import type { LlmClient } from "../src/contracts/llm-client.js";
import type { LlmResponse } from "../src/contracts/message.js";
import type { Tool, ToolCall } from "../src/contracts/tool.js";

const definition: Tool["definition"] = {
  name: "read_file", description: "read", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  },
};

/** 为每条测试创建客户端/工具，调用日志用来验证次数、历史和执行顺序。 */
function setup(responses: LlmResponse[], execute = vi.fn(async () => ({ ok: true, content: "file contents" }))) {
  const complete = vi.fn<LlmClient["complete"]>();
  for (const response of responses) complete.mockResolvedValueOnce(response);
  const registry = new RegisteredTools([{ definition, execute }]);
  return { client: { complete }, registry, complete, execute };
}

/** 构造内部工具调用，用于直接检验 core，不借助 HTTP adapter 替 core 做校验。 */
function call(id = "one", argumentsJson = '{"path":"README.md"}', name = "read_file"): ToolCall {
  return { id, name, argumentsJson };
}

/** 构造合法工具响应，允许测试在批次中插入各种结构错误。 */
function tools(calls: ToolCall[] = [call()]): LlmResponse {
  return { message: { role: "assistant", toolCalls: calls }, finishReason: "tool_calls" };
}

const final: LlmResponse = { message: { role: "assistant", content: " final answer \n" }, finishReason: "stop" };

describe("AgentLoop 状态与预算", () => {
  it("无工具响应只调用模型一次，返回明确成功结果", async () => {
    const ctx = setup([final]);
    expect(await agentLoop(ctx.client, ctx.registry, "model", "hi")).toEqual({
      finalText: " final answer \n", modelCalls: 1, toolResults: [], stopKind: "final_text",
    });
    expect(ctx.complete).toHaveBeenCalledTimes(1);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("保留 user→assistant→tool 顺序，工具结果带匹配 ID，早期请求数组不变", async () => {
    const ctx = setup([tools(), final]);
    const result = await agentLoop(ctx.client, ctx.registry, "model", "read");
    expect(result.modelCalls).toBe(2);
    expect(result.toolResults).toEqual([{ toolCallId: "one", name: "read_file", ok: true, content: "file contents" }]);
    expect(ctx.complete.mock.calls[0]?.[0].messages).toEqual([{ role: "user", content: "read" }]);
    expect(ctx.complete.mock.calls[1]?.[0].messages).toEqual([
      { role: "user", content: "read" }, tools().message,
      { role: "tool", toolCallId: "one", name: "read_file", content: "file contents" },
    ]);
    expect(ctx.complete.mock.calls[1]?.[0].tools).toEqual([definition]);
  });

  it("同批工具严格串行，并将所有结果按调用顺序返回", async () => {
    const events: string[] = [];
    const execute = vi.fn(async () => {
      const index = events.length;
      events.push(`start${index}`);
      await Promise.resolve();
      events.push(`end${index}`);
      return { ok: true, content: String(index) };
    });
    const ctx = setup([tools([call("a"), call("b"), call("c"), call("d")]), final], execute);
    const result = await agentLoop(ctx.client, ctx.registry, "model", "read");
    expect(events).toEqual(["start0", "end0", "start2", "end2", "start4", "end4", "start6", "end6"]);
    expect(result.toolResults.map((r) => r.toolCallId)).toEqual(["a", "b", "c", "d"]);
  });

  it.each([
    call("", '{}'), call("bad", "{"), call("bad", "null"), call("bad", "[]"),
    call("bad", '{}'), call("bad", '{"path":3}'), call("bad", '{"path":"x","extra":1}'),
    call("bad", '{"path":"x"}', ""), call("one"),
  ])("任一调用结构非法，全批不执行 %#", async (invalid) => {
    const ctx = setup([tools([call(), invalid])]);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toMatchObject({ code: "protocol_error" });
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(ctx.complete).toHaveBeenCalledTimes(1);
  });

  it("5 个调用整批拒绝；不会执行前 4 个", async () => {
    const ctx = setup([tools(Array.from({ length: 5 }, (_, i) => call(String(i))))]);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toMatchObject({ code: "protocol_error" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("第 8 次仍请求工具时只执行前 7 批，不发起第 9 次模型请求", async () => {
    const ctx = setup(Array.from({ length: 8 }, () => tools()));
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toMatchObject({ code: "loop_limit" });
    expect(ctx.complete).toHaveBeenCalledTimes(8);
    expect(ctx.execute).toHaveBeenCalledTimes(7);
    expect(ctx.complete.mock.calls[7]?.[0].messages).toHaveLength(15);
  });

  it("第 8 次返回最终文本允许成功", async () => {
    const ctx = setup([...Array.from({ length: 7 }, () => tools()), final]);
    expect((await agentLoop(ctx.client, ctx.registry, "model", "read")).modelCalls).toBe(8);
  });

  it("测试可缩小预算；最后一轮不执行工具", async () => {
    const ctx = setup([tools()]);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read", { maxModelCalls: 1 })).rejects.toBeInstanceOf(AgentLoopError);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("未知名称生成安全失败并让模型继续回答", async () => {
    const ctx = setup([tools([call("id", '{"path":"x"}', "missing")]), final]);
    const result = await agentLoop(ctx.client, ctx.registry, "model", "read");
    expect(result.toolResults[0]).toMatchObject({ ok: false, toolCallId: "id", content: "[unknown_tool] 未注册此工具。" });
    expect(ctx.complete.mock.calls[1]?.[0].messages[2]).toMatchObject({ role: "tool", content: "[unknown_tool] 未注册此工具。" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("文件执行错误作为 tool 消息回传而非使循环崩溃", async () => {
    const ctx = setup([tools(), final], vi.fn(async () => ({ ok: false, content: "[file_not_found] 文件不存在。" })));
    const result = await agentLoop(ctx.client, ctx.registry, "model", "read");
    expect(result.toolResults[0]?.ok).toBe(false);
    expect(ctx.complete.mock.calls[1]?.[0].messages[2]).toMatchObject({ content: "[file_not_found] 文件不存在。" });
  });

  it("finishReason=length 即使工具完整也不执行", async () => {
    const ctx = setup([{ ...tools(), finishReason: "length" }]);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toBeInstanceOf(ResponseError);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("空文本无调用失败；文本和调用共存时必须继续工具循环", async () => {
    const bad = setup([{ message: { role: "assistant", content: " " } }]);
    await expect(agentLoop(bad.client, bad.registry, "model", "read")).rejects.toBeInstanceOf(ResponseError);
    const ctx = setup([{ message: { ...tools().message, content: "先读取" } }, final]);
    expect((await agentLoop(ctx.client, ctx.registry, "model", "read")).modelCalls).toBe(2);
  });

  it("模型失败原样抛出，不执行工具", async () => {
    const ctx = setup([]);
    const error = new RequestError("network", "safe");
    ctx.complete.mockRejectedValue(error);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toBe(error);
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("调用前已取消时不请求模型", async () => {
    const ctx = setup([final]);
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read", {}, AbortSignal.abort())).rejects.toBeInstanceOf(AbortError);
    expect(ctx.complete).not.toHaveBeenCalled();
  });

  it("工具中取消后不追加成功结果、不执行下一工具或模型", async () => {
    const controller = new AbortController();
    const ctx = setup([tools([call("a"), call("b")])], vi.fn(async () => {
      controller.abort();
      return { ok: true, content: "should not append" };
    }));
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read", {}, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(ctx.complete).toHaveBeenCalledTimes(1);
    expect(ctx.execute).toHaveBeenCalledTimes(1);
  });

  it("不可恢复的工具异常转换为安全循环错误", async () => {
    const ctx = setup([tools()], vi.fn(async () => { throw new Error("/absolute/private/path SECRET"); }));
    await expect(agentLoop(ctx.client, ctx.registry, "model", "read")).rejects.toThrow("工具执行发生内部错误");
  });
});
