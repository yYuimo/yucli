import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { AbortError, ResponseError } from "../src/contracts/llm-client.js";
import type { LlmStreamEvent, Message } from "../src/contracts/message.js";
import { runTurnStream } from "../src/core/runTurnStream.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { completion, completionSse, readJson, sseFrame, startServer, streamChunk, writeSse } from "./helpers.js";
import type { Tool } from "../src/contracts/tool.js";
import type { ServerResponse } from "node:http";

let server: Awaited<ReturnType<typeof startServer>>;
let respond: (res: ServerResponse, index: number) => void | Promise<void>;
let requests: { body: { stream: boolean; messages: Message[]; tools?: unknown }; session: string | undefined }[];
const normal = completionSse(completion("你好！"));
const request = { model: "test-model", messages: [{ role: "user" as const, content: "hi" }] };

function toolDelta(index = 0, id = "one", args = '{"path":"README.md"}', name = "read_file") {
  return streamChunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
}
function client(timeoutMs = 2000) {
  return new OpenCodeGoClient({ apiKey: "test-key", baseUrl: server.baseUrl, timeoutMs });
}
async function collect(signal?: AbortSignal, timeoutMs = 2000) {
  const result: LlmStreamEvent[] = [];
  for await (const event of client(timeoutMs).stream(request, signal)) result.push(event);
  return result;
}
function registry(execute = vi.fn<Tool["execute"]>(async () => ({ ok: true, content: "file" }))) {
  return { execute, tools: new RegisteredTools([{
    definition: { name: "read_file", description: "read", parameters: {
      type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
    } }, execute,
  }]) };
}

beforeEach(async () => {
  requests = [];
  respond = (res) => writeSse(res, [normal]);
  server = await startServer(async (req, res) => {
    requests.push({ body: await readJson(req) as typeof requests[number]["body"], session: req.headers["x-opencode-session"] as string });
    await respond(res, requests.length - 1);
  });
});
afterEach(async () => { await server.close(); });

describe("真实 adapter SSE 解析与资源", () => {
  it("stream:true、空 tools 省略，每次 session 独立；complete:false 由旧测试保留", async () => {
    expect(await collect()).toEqual([{ type: "text_delta", text: "你好！" }, { type: "message_end", finishReason: "stop" }]);
    for await (const event of client().stream({ ...request, tools: [] })) void event;
    expect(requests.map((r) => r.body)).toEqual([1, 2].map(() => ({ ...request, stream: true })));
    expect(requests[0]?.session).not.toBe(requests[1]?.session);
    expect(requests[0]?.session).toMatch(/^[a-f0-9-]{36}$/u);
  });

  it("按单字节和时间间隔写流，UTF-8/事件/CRLF 可跨块且文本顺序不变", async () => {
    const bytes = Buffer.from(": heartbeat\r\n\r\n" +
      sseFrame(streamChunk({ content: "你" }), true) +
      sseFrame(streamChunk({ content: "好🙂" }), true) + sseFrame(streamChunk({}, "stop"), true));
    respond = (res) => writeSse(res, [...bytes].map((byte) => Uint8Array.of(byte)), 1);
    expect(await collect()).toEqual([
      { type: "text_delta", text: "你" }, { type: "text_delta", text: "好🙂" }, { type: "message_end", finishReason: "stop" },
    ]);
  });

  it("支持心跳、多行 data、未知字段与 reasoning 忽略", async () => {
    respond = (res) => writeSse(res, [': heartbeat\n\nevent: message\ndata: {"choices":\ndata: [{"delta":{"content":"ok","reasoning_content":"secret"},"finish_reason":"stop"}]}\n\n']);
    expect(await collect()).toEqual([{ type: "text_delta", text: "ok" }, { type: "message_end", finishReason: "stop" }]);
  });

  it("中间帧 usage:null 表示尚未提供统计，不产出 usage 事件", async () => {
    respond = (res) => writeSse(res, [sseFrame({ ...streamChunk({ content: "ok" }, "stop"), usage: null })]);
    expect(await collect()).toEqual([{ type: "text_delta", text: "ok" }, { type: "message_end", finishReason: "stop" }]);
  });

  it("服务端尚未结束 body 时即交付首个 delta，不缓冲整个响应", async () => {
    let end!: () => void;
    respond = (res) => {
      res.writeHead(200);
      res.write(sseFrame(streamChunk({ content: "first" })));
      end = () => res.end(sseFrame(streamChunk({}, "stop")));
    };
    const generator = client().stream(request);
    expect((await generator.next()).value).toEqual({ type: "text_delta", text: "first" });
    end();
    expect((await generator.next()).value).toEqual({ type: "message_end", finishReason: "stop" });
    expect((await generator.next()).done).toBe(true);
  });

  it("usage 独立发出，message_end 不带 usage，等值重复只发一次", async () => {
    const usage = { prompt_tokens: 2, completion_tokens: 3 };
    respond = (res) => writeSse(res, [sseFrame(streamChunk({ content: "ok" }, "stop", usage)),
      sseFrame(streamChunk({}, null, usage)), sseFrame("[DONE]")]);
    expect(await collect()).toEqual([
      { type: "text_delta", text: "ok" }, { type: "message_end", finishReason: "stop" },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } },
    ]);
  });

  it.each([
    'data: invalid\n\n', sseFrame("[DONE]"), sseFrame(streamChunk({ content: "partial" })),
    sseFrame({ choices: [] }), sseFrame({ choices: [{ delta: null }] }),
    sseFrame({ choices: [{ delta: {}, finish_reason: 3 }] }),
    sseFrame(streamChunk({ tool_calls: [{ index: -1 }] })),
    sseFrame(streamChunk({ tool_calls: [{ index: 0.5 }] })),
    sseFrame(streamChunk({ tool_calls: [{ index: 0, function: { arguments: {} } }] })),
    sseFrame(streamChunk({ content: 3 })), sseFrame(streamChunk({}, "stop", { prompt_tokens: -1 })),
    sseFrame(streamChunk({}, "stop", { completion_tokens: 1.5 })),
    sseFrame(streamChunk({}, "length")), 'data: {"choices":',
    sseFrame(streamChunk({ content: "ok" }, "stop")) + sseFrame(streamChunk({ content: "late" })),
    sseFrame(streamChunk({ content: "ok" }, "stop")) + sseFrame(streamChunk({}, "stop")),
  ])("非法协议失败且不泄露原始响应 %#", async (body) => {
    respond = (res) => writeSse(res, [body]);
    await expect(collect()).rejects.toBeInstanceOf(ResponseError);
  });

  it.each([Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xbd)])("拒绝非法或半截 UTF-8 %#", async (bytes) => {
    respond = (res) => writeSse(res, [bytes]);
    await expect(collect()).rejects.toBeInstanceOf(ResponseError);
  });

  it("在 message_end 前连接中断是 ResponseError", async () => {
    respond = (res) => {
      res.writeHead(200); res.write(sseFrame(streamChunk({ content: "partial" })));
      setTimeout(() => res.destroy(), 10);
    };
    await expect(collect()).rejects.toBeInstanceOf(ResponseError);
  });

  it("body 读取超时与外部取消分类独立", async () => {
    respond = (res) => { res.writeHead(200); res.write(": heartbeat\n\n"); };
    await expect(collect(undefined, 40)).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const result = collect(controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(result).rejects.toBeInstanceOf(AbortError);
  });

  it("预取消不发请求；generator 提前关闭取消 reader 并释放定时器", async () => {
    await expect(collect(AbortSignal.abort())).rejects.toBeInstanceOf(AbortError);
    expect(requests).toHaveLength(0);
    let close!: () => void;
    const closed = new Promise<void>((resolve) => { close = resolve; });
    respond = (res) => {
      res.on("close", close);
      res.writeHead(200); res.write(sseFrame(streamChunk({ content: "first" })));
    };
    const generator = client().stream(request);
    expect((await generator.next()).value).toEqual({ type: "text_delta", text: "first" });
    await generator.return(undefined);
    await closed;
  });

  it("非 2xx 诊断脱敏；网络失败分类稳定", async () => {
    respond = (res) => { res.writeHead(401); res.end("Authorization: Bearer test-key"); };
    await expect(collect()).rejects.toMatchObject({ code: "http", status: 401, responseSummary: "[REDACTED]" });
    const offline = await startServer(() => undefined);
    await offline.close();
    const disconnected = new OpenCodeGoClient({ apiKey: "test-key", baseUrl: offline.baseUrl, timeoutMs: 1000 });
    const pending = (async () => {
      for await (const event of disconnected.stream(request)) void event;
    })();
    await expect(pending).rejects.toMatchObject({ code: "network" });
  });
});

describe("真实 SSE → assembler → 流式 turn", () => {
  it("交错 index 独立拼装、按序执行，完整 assistant/tool 消息进入下一请求", async () => {
    const order: string[] = [];
    const ctx = registry(vi.fn(async () => {
      const number = order.length;
      order.push(`start${number}`);
      await Promise.resolve();
      order.push(`end${number}`);
      return { ok: true, content: "file" };
    }));
    respond = (res, index) => writeSse(res, index ? [normal] : [
      sseFrame(toolDelta(1, "b", '{"path":')), sseFrame(toolDelta(0, "a", '{"path":')),
      sseFrame(streamChunk({ tool_calls: [{ index: 1, function: { arguments: '"b.md"}' } }] })),
      sseFrame(streamChunk({ tool_calls: [{ index: 0, function: { arguments: '"a.md"}' } }] })),
      sseFrame(streamChunk({}, "tool_calls")), // 故意不发送 [DONE]
    ]);
    const history: Message[] = [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }];
    const onText = vi.fn();
    const result = await runTurnStream(client(), ctx.tools, "test", history, "read", onText);
    expect(result.modelCalls).toBe(2);
    expect(result.toolResults.map((r) => r.toolCallId)).toEqual(["a", "b"]);
    expect(order).toEqual(["start0", "end0", "start2", "end2"]);
    expect(ctx.execute.mock.calls.map((args) => args[0])).toEqual([{ path: "a.md" }, { path: "b.md" }]);
    expect(result.appendedMessages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(requests[1]?.body.messages).toMatchObject([
      ...history, { role: "user", content: "read" },
      { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "file" }, { role: "tool", tool_call_id: "b", content: "file" },
    ]);
    expect(history).toHaveLength(2);
    expect(onText).toHaveBeenCalledExactlyOnceWith("你好！");
  });

  it.each([
    toolDelta(1, "", '{"path":"x"}'), toolDelta(1, "b", "{"), toolDelta(1, "b", ""),
    toolDelta(1, "b", '{"path":"x"}', ""), toolDelta(1, "one"),
    toolDelta(1, "b", '{"path":3}'), toolDelta(1, "b", '{"path":"x","extra":1}'),
  ])("任一调用非法，整批不执行 %#", async (bad) => {
    respond = (res) => writeSse(res, [sseFrame(toolDelta()), sseFrame(bad), sseFrame(streamChunk({}, "tool_calls"))]);
    const ctx = registry();
    await expect(runTurnStream(client(), ctx.tools, "test", [], "read", vi.fn())).rejects.toMatchObject({ code: "protocol_error" });
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it.each(["length", "missing-end", "done-only", "changed-id", "changed-name", "five"])("批次停止边界 %s 不执行工具", async (kind) => {
    let frames = sseFrame(toolDelta());
    if (kind === "length") frames += sseFrame(streamChunk({}, "length"));
    if (kind === "done-only") frames += sseFrame("[DONE]");
    if (kind === "changed-id") frames += sseFrame(toolDelta(0, "changed"));
    if (kind === "changed-name") frames += sseFrame(toolDelta(0, "one", "", "other"));
    if (kind === "five") frames += [1, 2, 3, 4].map((i) => sseFrame(toolDelta(i, String(i)))).join("");
    respond = (res) => writeSse(res, [frames]);
    const ctx = registry();
    await expect(runTurnStream(client(), ctx.tools, "test", [], "read", vi.fn())).rejects.toThrow();
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("message_end 无工具且空白文本是 ResponseError", async () => {
    respond = (res) => writeSse(res, [sseFrame(streamChunk({ content: " \n" }, "stop"))]);
    await expect(runTurnStream(client(), registry().tools, "test", [], "hi", vi.fn())).rejects.toBeInstanceOf(ResponseError);
  });

  it("最多 8 请求，只执行前 7 批；第 8 轮文本允许成功", async () => {
    const ctx = registry();
    respond = (res) => writeSse(res, [sseFrame(toolDelta()), sseFrame(streamChunk({}, "tool_calls"))]);
    await expect(runTurnStream(client(), ctx.tools, "test", [], "read", vi.fn())).rejects.toMatchObject({ code: "loop_limit" });
    expect(requests).toHaveLength(8);
    expect(ctx.execute).toHaveBeenCalledTimes(7);
    requests = [];
    respond = (res, i) => writeSse(res, i === 7 ? [normal] : [sseFrame(toolDelta()), sseFrame(streamChunk({}, "tool_calls"))]);
    expect((await runTurnStream(client(), ctx.tools, "test", [], "read", vi.fn())).modelCalls).toBe(8);
  });

  it("工具期间取消不执行后续工具、不请求模型、不修改输入历史", async () => {
    const controller = new AbortController();
    const ctx = registry(vi.fn(async () => { controller.abort(); return { ok: true, content: "ignored" }; }));
    const history: Message[] = [];
    respond = (res) => writeSse(res, [sseFrame(toolDelta()), sseFrame(toolDelta(1, "two")), sseFrame(streamChunk({}, "tool_calls"))]);
    await expect(runTurnStream(client(), ctx.tools, "test", history, "read", vi.fn(), {}, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(history).toEqual([]);
    expect(ctx.execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });
});
