import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { RegisteredTools, executeToolBatch } from "../src/core/toolRegistry.js";
import { runTurnStream } from "../src/core/runTurnStream.js";
import { projectSessionHistory } from "../src/core/sessionHistory.js";
import { toolResultToMessage } from "../src/core/toolMessage.js";
import { ToolExecutionError } from "../src/contracts/tool.js";
import type { Tool, ToolCall, ToolRegistry } from "../src/contracts/tool.js";
import { AbortError, AgentLoopError, RequestError } from "../src/contracts/llm-client.js";
import { PersistenceError } from "../src/contracts/session.js";
import type { CoreTurnFact, TurnExecutionContext } from "../src/contracts/session.js";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, toolCompletion, writeSse } from "./helpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let respond: (response: ServerResponse, index: number) => Promise<void> | void;
let requests: { messages: Record<string, unknown>[] }[];
const profile = { provider: "opencode-go", model: "test-model" };
function call(id = "same", name = "read_file"): ToolCall { return { id, name, argumentsJson: '{"path":"x"}' }; }
function batch(ids = ["same"]) { return completionSse(toolCompletion(ids.map((id) => ({ id })))); }
const normal = completionSse(completion("完整回答"));
function client() { return new OpenCodeGoClient({ apiKey: "fake-key", baseUrl: server.baseUrl, timeoutMs: 2000 }); }
function registry(execute = vi.fn<Tool["execute"]>(async () => ({ ok: true, content: "结果" }))) {
  const tools = new RegisteredTools([{
    definition: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    execute,
  }]);
  return { tools, execute };
}
function context(record?: (fact: CoreTurnFact) => Promise<void>) {
  const facts: CoreTurnFact[] = [];
  const sink = vi.fn(async (fact: CoreTurnFact) => {
    facts.push(structuredClone(fact));
    await record?.(fact);
  });
  const execution: TurnExecutionContext = { turnId: "turn-a", facts: { record: sink } };
  return { facts, sink, execution };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => { resolve = finish; });
  return { promise, resolve };
}
beforeEach(async () => {
  requests = [];
  respond = (response, index) => writeSse(response, [index ? normal : batch()]);
  server = await startServer(async (request, response) => {
    requests.push(await readJson(request) as typeof requests[number]);
    await respond(response, requests.length - 1);
  });
});
afterEach(async () => { await server.close(); });

describe("T6 注册表输出交付与异常分类", () => {
  it.each([true, false])("完整合法输出 ok=%s 即使同时取消也先交付 ToolResult", async (ok) => {
    const controller = new AbortController();
    const ctx = registry(vi.fn(async () => { controller.abort(); return { ok, content: "" }; }));
    expect(await ctx.tools.execute(call(), controller.signal)).toEqual({ toolCallId: "same", name: "read_file", ok, content: "" });
  });

  it("未知工具有正常 ok:false，附加输出字段不污染调用身份或事实", async () => {
    const ctx = registry(vi.fn(async () => ({ ok: true, content: "", toolCallId: "wrong", name: "wrong", callMessageSeq: 999 })));
    expect(await ctx.tools.execute(call())).toEqual({ toolCallId: "same", name: "read_file", ok: true, content: "" });
    expect(await ctx.tools.execute(call("unknown", "missing"))).toMatchObject({ toolCallId: "unknown", name: "missing", ok: false });
  });

  it.each([undefined, null, { ok: "yes", content: "x" }, { ok: true }, { ok: true, content: 7 }])("非法工具输出 %# 归为安全 ToolExecutionError", async (value) => {
    const ctx = registry(vi.fn(async () => value as { ok: boolean; content: string }));
    const error: unknown = await ctx.tools.execute(call()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({ category: "tool", code: "tool_execution_failed" });
  });

  it("真正内部异常用固定安全摘要，不再误归 protocol_error", async () => {
    const ctx = registry(vi.fn(async () => { throw new Error("RAW SECRET /private/path"); }));
    const error = await ctx.tools.execute(call()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(String(error)).not.toMatch(/RAW SECRET|private\/path/u);
    expect(error).not.toBeInstanceOf(AgentLoopError);
  });

  it("已知取消/内部异常/保存故障保持身份；保存故障优先于并发取消", async () => {
    for (const error of [new AbortError("取消"), new ToolExecutionError(), new PersistenceError("sync_failed", "test", "安全故障")]) {
      const controller = new AbortController();
      const ctx = registry(vi.fn(async () => { controller.abort(); throw error; }));
      await expect(ctx.tools.execute(call(), controller.signal)).rejects.toBe(error);
    }
  });
});

describe("T6 assistant/逐项工具事实与保存屏障", () => {
  it("本地 SSE 两批复用调用 ID，assistantId 递增，事实/模型投影保持顺序且无 user/end 越权", async () => {
    respond = (res, index) => writeSse(res, [index < 2 ? batch() : normal]);
    const ctx = registry(vi.fn(async () => ({ ok: false, content: "" })));
    const delivery = context();
    const result = await runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_result", "assistant", "tool_start", "tool_result", "assistant"]);
    expect(delivery.facts.filter((fact) => fact.type === "assistant").map((fact) => fact.assistantId)).toEqual(["a1", "a2", "a3"]);
    expect(delivery.facts.filter((fact) => fact.type !== "assistant").map((fact) => fact.call.assistantId)).toEqual(["a1", "a1", "a2", "a2"]);
    expect(result.toolResults).toEqual([1, 2].map(() => ({ toolCallId: "same", name: "read_file", ok: false, content: "" })));
    expect(result.appendedMessages.filter((message) => message.role === "tool")).toEqual(result.toolResults.map(toolResultToMessage));
    expect(requests[2]!.messages.filter((message) => message.role === "tool")).toEqual([1, 2].map(() => ({ role: "tool", tool_call_id: "same", content: "" })));
    expect(JSON.stringify(result.appendedMessages)).not.toMatch(/"ok"|callMessageSeq|runtimeProfile|assistantId/u);
  });

  it.each(["assistant", "tool_start", "tool_result", "final-assistant", "tool_end"])("%s 的 record 未确认不能越过执行边界", async (stage) => {
    const entered = deferred();
    const release = deferred();
    const ctx = registry(stage === "tool_end" ? vi.fn(async () => { throw new ToolExecutionError(); }) : undefined);
    const delivery = context(async (fact) => {
      if (fact.type === stage && stage !== "assistant" || stage === "assistant" && fact.type === "assistant" && fact.assistantId === "a1" || stage === "final-assistant" && fact.type === "assistant" && fact.assistantId === "a2") {
        entered.resolve(); await release.promise;
      }
    });
    let settled = false;
    const running = runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution);
    const observed = running.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    try {
      expect(settled).toBe(false);
      if (stage === "assistant" || stage === "tool_start") expect(ctx.execute).not.toHaveBeenCalled();
      if (stage === "tool_result" || stage === "tool_end") expect(requests).toHaveLength(1);
      if (stage === "final-assistant") expect(requests).toHaveLength(2);
    } finally { release.resolve(); }
    if (stage === "tool_end") await expect(running).rejects.toBeInstanceOf(ToolExecutionError);
    else await running;
    await observed;
  });

  it.each(["assistant", "tool_start", "tool_result", "tool_end"])("%s 保存失败原样穿透，即使取消也不递归写结束或继续执行", async (stage) => {
    const error = new PersistenceError("sync_failed", "test", "保存失败");
    const controller = new AbortController();
    const ctx = registry(stage === "tool_end" ? vi.fn(async () => { throw new ToolExecutionError(); }) : undefined);
    const delivery = context(async (fact) => { if (fact.type === stage) { controller.abort(); throw error; } });
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, controller.signal, delivery.execution)).rejects.toBe(error);
    expect(delivery.facts.at(-1)!.type).toBe(stage);
    expect(requests).toHaveLength(1);
    expect(ctx.execute).toHaveBeenCalledTimes(stage === "tool_result" || stage === "tool_end" ? 1 : 0);
  });

  it("tool_start 确认后取消，记录 cancelled_before_dispatch，再拒绝且不进入注册表", async () => {
    const controller = new AbortController();
    const ctx = registry();
    const dispatch = vi.spyOn(ctx.tools, "execute");
    const delivery = context(async (fact) => { if (fact.type === "tool_start") controller.abort(); });
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, controller.signal, delivery.execution)).rejects.toBeInstanceOf(AbortError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_end"]);
    expect(delivery.facts.at(-1)).toMatchObject({ end: { outcome: "cancelled", error: { code: "cancelled_before_dispatch" } } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it.each(["result", "result-save", "throw-cancel"])("注册表进入后 %s 取消，保留实际结果或实际 user_interrupt，不重复终止", async (stage) => {
    const controller = new AbortController();
    respond = (res) => writeSse(res, [batch(["one", "two"])]);
    const ctx = registry(vi.fn(async () => {
      if (stage !== "result-save") controller.abort();
      if (stage === "throw-cancel") throw new AbortError("真实工具取消");
      return { ok: true, content: "必须保留" };
    }));
    const delivery = context(async (fact) => { if (stage === "result-save" && fact.type === "tool_result") controller.abort(); });
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, controller.signal, delivery.execution)).rejects.toBeInstanceOf(AbortError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", stage === "throw-cancel" ? "tool_end" : "tool_result"]);
    if (stage === "throw-cancel") expect(delivery.facts.at(-1)).toMatchObject({ end: { error: { code: "user_interrupt" } } });
    else expect(delivery.facts.at(-1)).toMatchObject({ result: { ok: true, content: "必须保留" } });
    expect(ctx.execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
  });

  it("assistant 保存期间取消，在 start 前停止，不产生未分派工具事实", async () => {
    const controller = new AbortController();
    const ctx = registry();
    const delivery = context(async (fact) => { if (fact.type === "assistant") controller.abort(); });
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, controller.signal, delivery.execution)).rejects.toBeInstanceOf(AbortError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant"]);
    expect(ctx.execute).not.toHaveBeenCalled();
  });
});

describe("T6 补充交付边界", () => {
  it("最终 assistant 保存拒绝原样穿透，不返回临时成功结果", async () => {
    respond = (res) => writeSse(res, [normal]);
    const error = new PersistenceError("write_failed", "test", "保存失败");
    const delivery = context(async () => { throw error; });
    const ctx = registry();
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution)).rejects.toBe(error);
    expect(delivery.facts).toHaveLength(1);
    expect(delivery.facts[0]).toMatchObject({ type: "assistant", assistantId: "a1", message: { content: "完整回答" } });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("第一项结果已确认后第二项真正取消，只为第二项保存 tool_end", async () => {
    respond = (res) => writeSse(res, [batch(["one", "two", "three"])]);
    const controller = new AbortController();
    const execute = vi.fn<Tool["execute"]>()
      .mockResolvedValueOnce({ ok: true, content: "第一项已完成" })
      .mockImplementationOnce(async () => { controller.abort(); throw new AbortError("第二项取消"); });
    const delivery = context();
    await expect(runTurnStream(client(), registry(execute).tools, "model", [], "问题", vi.fn(), {}, controller.signal, delivery.execution)).rejects.toBeInstanceOf(AbortError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_result", "tool_start", "tool_end"]);
    expect(delivery.facts[2]).toMatchObject({ call: { toolCallId: "one" }, result: { content: "第一项已完成" } });
    expect(delivery.facts[4]).toMatchObject({ call: { toolCallId: "two" }, end: { error: { code: "user_interrupt" } } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
  });

  it("未知工具按 assistant/start/result(ok:false) 交付，模型收到不含 ok 的结果", async () => {
    respond = (res, index) => writeSse(res, [index ? normal : completionSse(toolCompletion([{ id: "missing", name: "not_registered" }]))]);
    const delivery = context();
    const ctx = registry();
    const result = await runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_result", "assistant"]);
    expect(result.toolResults[0]).toMatchObject({ name: "not_registered", ok: false });
    expect(requests[1]!.messages[2]).toEqual({ role: "tool", tool_call_id: "missing", content: "[unknown_tool] 未注册此工具。" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });
});

describe("T6 批次预检、额度和错误传播", () => {
  it.each(["bad-arguments", "duplicate", "five", "blank", "length", "missing-end", "late-frame"])("流式 %s 不交付伪造 assistant，不执行任何工具", async (stage) => {
    let response = stage === "bad-arguments" ? completionSse(toolCompletion([{ id: "one" }, { id: "two", argumentsJson: '{"path":7}' }]))
      : stage === "duplicate" ? batch(["one", "one"])
      : stage === "five" ? batch(["1", "2", "3", "4", "5"])
      : stage === "blank" ? completionSse(completion(" \n"))
      : stage === "length" ? completionSse(toolCompletion([{ id: "one" }], "length"))
      : stage === "missing-end" ? sseFrame(streamChunk({ content: "未完整" })) : batch();
    if (stage === "late-frame") response = response.replace(sseFrame("[DONE]"), sseFrame("not-json") + sseFrame("[DONE]"));
    respond = (res) => writeSse(res, [response]);
    const ctx = registry();
    const delivery = context();
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution)).rejects.toThrow();
    expect(delivery.facts).toEqual([]);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it.each([1, 8])("%i 次模型上限时保留末次合法 assistant，末批不执行、不保存 start", async (maxModelCalls) => {
    respond = (res) => writeSse(res, [batch()]);
    const ctx = registry();
    const delivery = context();
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), { maxModelCalls }, undefined, delivery.execution)).rejects.toMatchObject({ code: "loop_limit" });
    expect(requests).toHaveLength(maxModelCalls);
    expect(ctx.execute).toHaveBeenCalledTimes(maxModelCalls - 1);
    expect(delivery.facts.filter((fact) => fact.type === "assistant")).toHaveLength(maxModelCalls);
    expect(delivery.facts.at(-1)).toMatchObject({ type: "assistant", assistantId: `a${maxModelCalls}` });
    expect(delivery.facts.filter((fact) => fact.type === "tool_start")).toHaveLength(maxModelCalls - 1);
  });

  it("四项工具按保存/分派/结果屏障逐个执行，不与后项重叠", async () => {
    const order: string[] = [];
    respond = (res, index) => writeSse(res, [index ? normal : batch(["1", "2", "3", "4"])]);
    const ctx = registry(vi.fn(async () => {
      order.push("execute"); await Promise.resolve(); order.push("returned"); return { ok: true, content: "" };
    }));
    const delivery = context(async (fact) => {
      if (fact.type === "tool_start" || fact.type === "tool_result") order.push(`${fact.type}:${fact.call.toolCallId}`);
    });
    const result = await runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution);
    expect(result.toolResults).toHaveLength(4);
    expect(order).toEqual(["1", "2", "3", "4"].flatMap((id) => [`tool_start:${id}`, "execute", "returned", `tool_result:${id}`]));
  });

  it("工具后模型失败保留已交付事实，不伪造 assistant/end，不返回成功组", async () => {
    respond = (res, index) => {
      if (index) { res.writeHead(503).end("RAW SECRET"); return; }
      return writeSse(res, [batch()]);
    };
    const delivery = context();
    const history = [{ role: "user" as const, content: "旧问题" }, { role: "assistant" as const, content: "旧回答" }];
    await expect(runTurnStream(client(), registry().tools, "model", history, "问题", vi.fn(), {}, undefined, delivery.execution)).rejects.toBeInstanceOf(RequestError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_result"]);
    expect(history).toHaveLength(2);
  });

  it("工具内部异常形成合法 tool_end 的安全分类，不归 protocol、不执行第二项", async () => {
    respond = (res) => writeSse(res, [batch(["one", "two"])]);
    const ctx = registry(vi.fn(async () => { throw new Error("RAW SECRET"); }));
    const delivery = context();
    await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, delivery.execution)).rejects.toBeInstanceOf(ToolExecutionError);
    expect(delivery.facts.map((fact) => fact.type)).toEqual(["assistant", "tool_start", "tool_end"]);
    expect(delivery.facts.at(-1)).toMatchObject({ end: { outcome: "failed", error: { category: "tool", code: "tool_execution_failed" } } });
    expect(JSON.stringify(delivery.facts)).not.toContain("RAW SECRET");
    expect(ctx.execute).toHaveBeenCalledOnce();
  });

  it("执行器独立调用仍整批预检，后一项非法/超过4时不保存 start、不执行前项", async () => {
    for (const calls of [[call("a"), { ...call("b"), argumentsJson: "{" }], Array.from({ length: 5 }, (_, i) => call(String(i)))]) {
      const ctx = registry();
      const delivery = context();
      await expect(executeToolBatch(ctx.tools, calls, undefined, { ...delivery.execution, assistantId: "a1" })).rejects.toMatchObject({ code: "protocol_error" });
      expect(delivery.facts).toEqual([]);
      expect(ctx.execute).not.toHaveBeenCalled();
    }
  });

  it.each(["internal", "wrong-result", "persistence", "protocol"])("注入注册表 %s 的边界同样安全分类/穿透", async (stage) => {
    const error = stage === "persistence" ? new PersistenceError("ownership_lost", "test", "保存故障")
      : stage === "protocol" ? new AgentLoopError("protocol_error", "协议故障") : new Error("RAW SECRET");
    const injected: ToolRegistry = { definitions: () => [], execute: async () => {
      if (stage === "wrong-result") return { toolCallId: "wrong", name: "read_file", ok: true, content: "" };
      throw error;
    } };
    const delivery = context();
    const running = executeToolBatch(injected, [call()], undefined, { ...delivery.execution, assistantId: "a1" });
    if (stage === "persistence" || stage === "protocol") {
      await expect(running).rejects.toBe(error);
      expect(delivery.facts.map((fact) => fact.type)).toEqual(["tool_start"]);
    } else {
      await expect(running).rejects.toBeInstanceOf(ToolExecutionError);
      expect(delivery.facts.map((fact) => fact.type)).toEqual(["tool_start", "tool_end"]);
    }
  });
});

describe("T6 实时/存储/恢复投影的连接", () => {
  it("本地 mock SSE → T4/T5 writer → 恢复快照与实时组一致；恢复投影不发请求/重跑工具", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t6-facts-")));
    const adapter = new SessionFileAdapter({ storageRoot: join(directory, ".yucli") });
    const ctx = registry(vi.fn(async () => ({ ok: false, content: "" })));
    respond = (res, index) => writeSse(res, [index < 2 ? batch() : normal]);
    try {
      const opened = await adapter.create(directory);
      const turnId = randomUUID();
      // 测试显式写 user/turn_end 只组装日志 fixture，不实现 T7 协调器或提交凭证。
      await opened.writer.appendDurable({ type: "user", turnId, runtimeProfile: profile, message: { role: "user", content: "问题" } });
      const execution: TurnExecutionContext = { turnId, facts: { record: async (fact) => { await opened.writer.appendDurable(fact); } } };
      const result = await runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, undefined, execution);
      await opened.writer.appendDurable({ type: "turn_end", turnId, end: { outcome: "success" } });
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: directory });
      const history = projectSessionHistory(restored.snapshot.recentSuccessfulTurns);
      expect(history).toEqual([result.appendedMessages]);
      expect(requests).toHaveLength(3);
      expect(ctx.execute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(history)).not.toMatch(/"ok"|callMessageSeq|runtimeProfile|assistantId|turnId|"seq"/u);
    } finally { await adapter.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["cancelled-before", "tool-failed"])("实时 %s 的工具 end 能通过 T3/T4 校验且恢复不进入成功历史", async (stage) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t6-failure-")));
    const adapter = new SessionFileAdapter({ storageRoot: join(directory, ".yucli") });
    const controller = new AbortController();
    const ctx = registry(stage === "tool-failed" ? vi.fn(async () => { throw new Error("RAW SECRET"); }) : undefined);
    try {
      const opened = await adapter.create(directory);
      const turnId = randomUUID();
      await opened.writer.appendDurable({ type: "user", turnId, runtimeProfile: profile, message: { role: "user", content: "问题" } });
      const execution: TurnExecutionContext = { turnId, facts: { record: async (fact) => {
        await opened.writer.appendDurable(fact);
        if (stage === "cancelled-before" && fact.type === "tool_start") controller.abort();
      } } };
      await expect(runTurnStream(client(), ctx.tools, "model", [], "问题", vi.fn(), {}, controller.signal, execution)).rejects.toBeInstanceOf(stage === "tool-failed" ? ToolExecutionError : AbortError);
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: directory });
      expect(restored.snapshot.interruptedTurnCount).toBe(1); // T6 不拥有 turn_end，不伪装完整终止
      expect(projectSessionHistory(restored.snapshot.recentSuccessfulTurns)).toEqual([]);
      expect(requests).toHaveLength(1);
    } finally { await adapter.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
