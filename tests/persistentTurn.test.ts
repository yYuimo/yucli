import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runPersistentTurn, type PersistentTurnInput } from "../src/core/runPersistentTurn.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { projectSessionHistory } from "../src/core/sessionHistory.js";
import { AbortError, AgentLoopError, RequestError, ResponseError } from "../src/contracts/llm-client.js";
import { ToolExecutionError, type Tool } from "../src/contracts/tool.js";
import { PersistenceError, type SessionWriter, type TurnFact } from "../src/contracts/session.js";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";
import { completion, completionSse, readJson, startServer, toolCompletion, writeSse } from "./helpers.js";
import { deferred, flush } from "./persistenceHelpers.js";

let server: Awaited<ReturnType<typeof startServer>>;
let respond: (res: ServerResponse, index: number) => void | Promise<void>;
let requests: unknown[];
const profile = { provider: "opencode-go", model: "test-model" };
const answer = completionSse(completion("完整回答"));
const calls = completionSse(toolCompletion([{ id: "same" }]));

/** 每个 fixture 使用真实 HTTP adapter 和本地 mock SSE；保存能力可逐条暂停或拒绝。 */
function setup(record?: (fact: TurnFact) => Promise<void>, execute?: Tool["execute"]) {
  const facts: TurnFact[] = [];
  const append = vi.fn(async (fact: TurnFact) => {
    facts.push(structuredClone(fact));
    await record?.(fact);
    return { confirmedSeq: facts.length };
  });
  const writer: SessionWriter = { appendDurable: append, close: vi.fn(async () => {}) };
  const runTool = vi.fn(execute ?? (async () => ({ ok: false, content: "" })));
  const registry = new RegisteredTools([{
    definition: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    execute: runTool,
  }]);
  const input: PersistentTurnInput = {
    writer, turnId: randomUUID(), runtimeProfile: profile, registry,
    client: new OpenCodeGoClient({ apiKey: "fake-key", baseUrl: server.baseUrl, timeoutMs: 2000 }),
    model: "test-model", history: [], prompt: "新问题", onText: vi.fn(),
  };
  return { input, facts, append, runTool };
}
beforeEach(async () => {
  requests = [];
  respond = (res, index) => writeSse(res, [index ? answer : calls]);
  server = await startServer(async (req, res) => { requests.push(await readJson(req)); await respond(res, requests.length - 1); });
});
afterEach(async () => { await server.close(); });

describe("T7 成功提交和逐项屏障", () => {
  it("唯一 user/end、profile 与原 turnId，完整成功保存后交付凭证，不修改旧历史", async () => {
    const ctx = setup();
    ctx.input.history = [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }];
    const before = structuredClone(ctx.input.history);
    const committed = await runPersistentTurn(ctx.input);
    expect(committed).toMatchObject({ status: "committed", turnId: ctx.input.turnId, result: { finalText: "完整回答", modelCalls: 2 } });
    expect(ctx.facts.map((fact) => fact.type)).toEqual(["user", "assistant", "tool_start", "tool_result", "assistant", "turn_end"]);
    expect(ctx.facts[0]).toMatchObject({ runtimeProfile: profile });
    expect(ctx.facts.at(-1)).toEqual({ type: "turn_end", turnId: ctx.input.turnId, end: { outcome: "success" } });
    expect(ctx.facts.every((fact) => fact.turnId === ctx.input.turnId)).toBe(true);
    expect(ctx.input.history).toEqual(before);
    expect(committed.result.toolResults[0]).toMatchObject({ ok: false });
    expect(JSON.stringify(committed.result.appendedMessages)).not.toMatch(/"ok"|runtimeProfile|"seq"/u);
    expect(ctx.input.writer.close).not.toHaveBeenCalled();
  });

  it.each(["user", "assistant", "tool_start", "tool_result", "turn_end", "tool_end"])("%s 保存未确认不得越过下一执行/提交边界", async (stage) => {
    const entered = deferred(); const gate = deferred();
    const ctx = setup(async (fact) => { if (fact.type === stage) { entered.resolve(); await gate.promise; } }, stage === "tool_end" ? async () => { throw new ToolExecutionError(); } : undefined);
    let done = false;
    const running = runPersistentTurn(ctx.input);
    const observed = running.then(() => { done = true; }, () => { done = true; });
    await entered.promise;
    try {
      expect(done).toBe(false);
      if (stage === "user") expect(requests).toHaveLength(0);
      if (stage === "assistant" || stage === "tool_start") expect(ctx.runTool).not.toHaveBeenCalled();
      if (stage === "tool_result" || stage === "tool_end") expect(requests).toHaveLength(1);
      if (stage === "tool_end") expect(ctx.facts.some((fact) => fact.type === "turn_end")).toBe(false);
    } finally { gate.resolve(); }
    if (stage === "tool_end") await expect(running).rejects.toBeInstanceOf(ToolExecutionError); else await running;
    await observed;
  });

  it("本地 SSE → 协调方 → 真实 writer → 恢复，成功凭证与可恢复消息组一致", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "yucli-t7-turn-")));
    const adapter = new SessionFileAdapter({ storageRoot: join(dir, ".yucli") });
    try {
      const opened = await adapter.create(dir);
      const ctx = setup(); ctx.input.writer = opened.writer;
      const result = await runPersistentTurn(ctx.input);
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: dir });
      expect(projectSessionHistory(restored.snapshot.recentSuccessfulTurns)).toEqual([result.result.appendedMessages]);
    } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("T7 业务分类、唯一终止和存储故障优先", () => {
  const secret = "RAW SECRET /private/path Authorization: Bearer sensitive";
  it.each([
    [new RequestError("network", secret), "failed", "model", "network"],
    [new RequestError("http", secret, 503, secret), "failed", "model", "http"],
    [new RequestError("timeout", secret), "timeout", "timeout", "request_timeout"],
    [new ResponseError(secret), "failed", "model", "invalid_response"],
    [new AgentLoopError("protocol_error", secret), "failed", "protocol", "protocol_error"],
    [new AgentLoopError("loop_limit", secret), "failed", "limit", "loop_limit"],
    [new ToolExecutionError(), "failed", "tool", "tool_execution_failed"],
    [new AbortError(secret), "cancelled", "cancellation", "user_interrupt"],
    [new Error(secret), "failed", "internal", "internal_error"],
    [undefined, "failed", "internal", "internal_error"],
  ])("%s 映射 %s/%s/%s，保存后重抛原异常", async (error, outcome, category, code) => {
    const ctx = setup();
    vi.spyOn(ctx.input.registry, "definitions").mockImplementation(() => { throw error; });
    const observed = await runPersistentTurn(ctx.input).then(() => ({ unexpected: true }), (caught: unknown) => ({ caught }));
    expect(observed).toEqual({ caught: error });
    expect(ctx.facts).toHaveLength(2);
    expect(ctx.facts[1]).toMatchObject({ type: "turn_end", end: { outcome, error: { category, code } } });
    expect(JSON.stringify(ctx.facts)).not.toMatch(/RAW SECRET|private\/path|Bearer|stack|responseSummary/u);
    if (error instanceof RequestError && error.code === "http") expect(ctx.facts[1]).toMatchObject({ end: { error: { httpStatus: 503 } } });
    expect(requests).toHaveLength(0);
  });

  it.each([99, 600, NaN, 1.5])("非法 HTTP 状态 %s 不进入安全错误数据", async (status) => {
    const ctx = setup(); const error = new RequestError("http", secret, status);
    vi.spyOn(ctx.input.registry, "definitions").mockImplementation(() => { throw error; });
    await expect(runPersistentTurn(ctx.input)).rejects.toBe(error);
    expect(ctx.facts[1]).not.toHaveProperty("end.error.httpStatus");
  });

  it.each(["user", "assistant", "tool_start", "tool_result", "tool_end", "final-assistant", "turn_end"])("%s 的 PersistenceError 原样穿透且不递归终止或继续模型", async (stage) => {
    const error = new PersistenceError("sync_failed", "test", "保存失败");
    const controller = new AbortController();
    const ctx = setup(async (fact) => { if (fact.type === stage || stage === "final-assistant" && fact.type === "assistant" && !fact.message.toolCalls) { controller.abort(); throw error; } }, stage === "tool_end" ? async () => { throw new ToolExecutionError(); } : undefined);
    ctx.input.signal = controller.signal;
    await expect(runPersistentTurn(ctx.input)).rejects.toBe(error);
    expect(ctx.facts.at(-1)!.type).toBe(stage === "final-assistant" ? "assistant" : stage);
    expect(ctx.facts.filter((fact) => fact.type === "turn_end")).toHaveLength(stage === "turn_end" ? 1 : 0);
    expect(requests.length).toBe(stage === "user" ? 0 : stage === "turn_end" || stage === "final-assistant" ? 2 : 1);
  });

  it.each(["success", "failed", "cancelled", "timeout"])("固定 %s 后 turn_end 保存期间再次取消，不覆盖/重复终止", async (outcome) => {
    const gate = deferred(); const entered = deferred(); const controller = new AbortController();
    const ctx = setup(async (fact) => { if (fact.type === "turn_end") { entered.resolve(); await gate.promise; } });
    const cause = outcome === "timeout" ? new RequestError("timeout", secret) : outcome === "cancelled" ? new AbortError(secret) : new ResponseError(secret);
    if (outcome !== "success") vi.spyOn(ctx.input.registry, "definitions").mockImplementation(() => { throw cause; });
    ctx.input.signal = controller.signal;
    const running = runPersistentTurn(ctx.input); const observed = running.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(); await flush();
    expect(ctx.facts.filter((fact) => fact.type === "turn_end")).toHaveLength(1);
    expect(ctx.facts.at(-1)).toMatchObject({ end: { outcome } });
    gate.resolve();
    if (outcome === "success") expect(await running).toMatchObject({ status: "committed" }); else await expect(running).rejects.toBe(cause);
    await observed;
  });

  it.each(["cancelled", "timeout"])("%s 收尾保存拒绝时抛保存故障，覆盖业务异常而不再次保存", async (kind) => {
    const cause = kind === "timeout" ? new RequestError("timeout", secret) : new AbortError(secret);
    const error = new PersistenceError("write_failed", "append", "终止保存失败");
    const ctx = setup(async (fact) => { if (fact.type === "turn_end") throw error; });
    vi.spyOn(ctx.input.registry, "definitions").mockImplementation(() => { throw cause; });
    await expect(runPersistentTurn(ctx.input)).rejects.toBe(error);
    expect(ctx.facts.map((fact) => fact.type)).toEqual(["user", "turn_end"]);
  });

  it.each(["before", "user", "final-assistant", "start", "result"])("%s 取消保持正确边界，只有一个 cancelled turn_end", async (stage) => {
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    const ctx = setup(async (fact) => {
      if (stage === "user" && fact.type === "user" || stage === "start" && fact.type === "tool_start" || stage === "result" && fact.type === "tool_result" || stage === "final-assistant" && fact.type === "assistant" && !fact.message.toolCalls) controller.abort();
    });
    ctx.input.signal = controller.signal;
    await expect(runPersistentTurn(ctx.input)).rejects.toBeInstanceOf(AbortError);
    expect(ctx.facts.at(-1)).toMatchObject({ type: "turn_end", end: { outcome: "cancelled", error: { code: "user_interrupt" } } });
    expect(ctx.facts.filter((fact) => fact.type === "turn_end")).toHaveLength(1);
    if (stage === "before" || stage === "user") expect(requests).toHaveLength(0);
    if (stage === "start") { expect(ctx.runTool).not.toHaveBeenCalled(); expect(ctx.facts.at(-2)).toMatchObject({ type: "tool_end", end: { error: { code: "cancelled_before_dispatch" } } }); }
    if (stage === "result") expect(ctx.facts.at(-2)).toMatchObject({ type: "tool_result" });
  });

  it("工具后 HTTP 模型失败保留事实，只保存失败 turn_end", async () => {
    respond = (res, index) => { if (index) { res.writeHead(503).end(secret); return; } return writeSse(res, [calls]); };
    const ctx = setup();
    await expect(runPersistentTurn(ctx.input)).rejects.toBeInstanceOf(RequestError);
    expect(ctx.facts.map((fact) => fact.type)).toEqual(["user", "assistant", "tool_start", "tool_result", "turn_end"]);
    expect(ctx.facts.at(-1)).toMatchObject({ end: { error: { code: "http", httpStatus: 503 } } });
    expect(JSON.stringify(ctx.facts)).not.toContain(secret);
  });

  it("第8个合法调用先保存 assistant，再固定 loop_limit，末批不执行", async () => {
    respond = (res) => writeSse(res, [calls]);
    const ctx = setup();
    await expect(runPersistentTurn(ctx.input)).rejects.toMatchObject({ code: "loop_limit" });
    expect(requests).toHaveLength(8); expect(ctx.runTool).toHaveBeenCalledTimes(7);
    expect(ctx.facts.at(-2)).toMatchObject({ type: "assistant", assistantId: "a8" });
    expect(ctx.facts.at(-1)).toMatchObject({ type: "turn_end", end: { outcome: "failed", error: { category: "limit", code: "loop_limit" } } });
  });

  it("success 已落盘但确认丢失：不返回凭证、不重写终止；恢复依据实际文件", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "yucli-t7-lost-")));
    const adapter = new SessionFileAdapter({ storageRoot: join(dir, ".yucli") });
    try {
      const opened = await adapter.create(dir); const ctx = setup();
      const error = new PersistenceError("sync_failed", "test_confirmation", "保存确认丢失");
      const append = vi.fn(async (fact: TurnFact) => {
        const receipt = await opened.writer.appendDurable(fact);
        if (fact.type === "turn_end") throw error;
        return receipt;
      });
      ctx.input.writer = { appendDurable: append, close: () => opened.writer.close() };
      await expect(runPersistentTurn(ctx.input)).rejects.toBe(error);
      expect(append.mock.calls.filter(([fact]) => fact.type === "turn_end")).toHaveLength(1);
      expect(ctx.input.history).toEqual([]);
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: dir });
      expect(restored.snapshot.recentSuccessfulTurns).toHaveLength(1);
      expect(requests).toHaveLength(2);
    } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it.each([new Error(secret), new RequestError("timeout", secret), new RequestError("http", secret, 503, secret)])("真实 writer 接受安全终止 %s，恢复不提交失败组", async (cause) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "yucli-t7-failed-")));
    const adapter = new SessionFileAdapter({ storageRoot: join(dir, ".yucli") });
    try {
      const opened = await adapter.create(dir); const ctx = setup(); ctx.input.writer = opened.writer;
      vi.spyOn(ctx.input.registry, "definitions").mockImplementation(() => { throw cause; });
      await expect(runPersistentTurn(ctx.input)).rejects.toBe(cause);
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId: opened.snapshot.meta.sessionId, cwd: dir });
      expect(restored.snapshot.recentSuccessfulTurns).toEqual([]); expect(restored.snapshot.interruptedTurnCount).toBe(0);
    } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
