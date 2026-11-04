import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoClient } from "../src/adapters/opencode-go/OpenCodeGoClient.js";
import { ReadFileTool } from "../src/adapters/filesystem/ReadFileTool.js";
import { agentLoop } from "../src/core/agentLoop.js";
import { RegisteredTools } from "../src/core/toolRegistry.js";
import { ResponseError } from "../src/contracts/llm-client.js";
import { completion, readJson, startServer, toolCompletion } from "./helpers.js";

const apiKey = "local-tool-http-key";

describe("工具循环的真实本地 HTTP 往返", () => {
  let cwd: string;
  let tool: ReadFileTool;
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "yucli-tool-http-"));
    await writeFile(join(cwd, "README.md"), "真实文件内容\n");
    tool = new ReadFileTool(cwd);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await rm(cwd, { recursive: true, force: true });
  });

  /** 创建 HTTP adapter，所有请求只访问本地服务，不加载 .env。 */
  async function serve(handler: Parameters<typeof startServer>[0]) {
    const server = await startServer(handler);
    servers.push(server);
    return new OpenCodeGoClient({ apiKey, baseUrl: server.baseUrl, timeoutMs: 2000 });
  }

  it("工具定义、assistant 调用、tool 消息映射正确，每轮路由 UUID 独立", async () => {
    const bodies: unknown[] = [];
    const ids: unknown[] = [];
    const client = await serve(async (req, res) => {
      bodies.push(await readJson(req));
      ids.push(req.headers["x-opencode-session"]);
      res.end(JSON.stringify(bodies.length === 1 ? toolCompletion() : completion("总结完成")));
    });

    const result = await agentLoop(client, new RegisteredTools([tool]), "model", "read");
    expect(result).toMatchObject({ finalText: "总结完成", modelCalls: 2, stopKind: "final_text" });
    expect(bodies[0]).toEqual({
      model: "model", messages: [{ role: "user", content: "read" }], stream: false,
      tools: [{ type: "function", function: tool.definition }],
    });
    expect(bodies[1]).toEqual({
      model: "model", stream: false, tools: [{ type: "function", function: tool.definition }],
      messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: "", tool_calls: [{
          id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' },
        }] },
        { role: "tool", tool_call_id: "call-1", content: "真实文件内容\n" },
      ],
    });
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => typeof id === "string" && id.length === 36)).toBe(true);
  });

  it.each([undefined, []])("无工具字段或空数组维持阶段 01 精确请求体 %j", async (tools) => {
    let captured: unknown;
    const client = await serve(async (req, res) => {
      captured = await readJson(req);
      res.end(JSON.stringify(completion()));
    });
    await client.complete({ model: "model", messages: [{ role: "user", content: "hi" }], ...(tools ? { tools } : {}) });
    expect(captured).toEqual({ model: "model", messages: [{ role: "user", content: "hi" }], stream: false });
  });

  it("发送 tool 消息省略 name，并且不改变输入对象", async () => {
    let body: unknown;
    const client = await serve(async (req, res) => {
      body = await readJson(req);
      res.end(JSON.stringify(completion()));
    });
    const messages = [{ role: "tool" as const, toolCallId: "id", name: "read_file", content: "content" }];
    const copy = structuredClone(messages);
    await client.complete({ model: "m", messages });
    expect(body).toMatchObject({ messages: [{ role: "tool", tool_call_id: "id", content: "content" }] });
    expect((body as { messages: object[] }).messages[0]).not.toHaveProperty("name");
    expect(messages).toEqual(copy);
  });

  it.each([undefined, null, "", " "])("有调用时接受 content=%j，保留未知 finish_reason", async (content) => {
    const response = toolCompletion(undefined, "vendor_custom");
    const raw: object = { ...response, choices: [{
      ...response.choices[0], message: { ...response.choices[0]?.message, content },
    }] };
    const client = await serve((_req, res) => res.end(JSON.stringify(raw)));
    expect(await client.complete({ model: "m", messages: [] })).toMatchObject({
      message: { toolCalls: [{ id: "call-1", name: "read_file" }] }, finishReason: "vendor_custom",
    });
  });

  it.each([
    { id: "bad", argumentsJson: "{" }, { id: "bad", argumentsJson: "[]" },
    { id: "bad", argumentsJson: "{}" }, { id: "bad", argumentsJson: '{"path":7}' },
    { id: "bad", argumentsJson: '{"path":"x","extra":1}' }, { id: "call-1" }, { id: "" }, { id: "bad", name: "" },
  ])("HTTP 返回批次中任意非法结构都不执行有效的前一项 %#", async (bad) => {
    const execute = vi.spyOn(tool, "execute");
    const client = await serve((_req, res) => res.end(JSON.stringify(toolCompletion([{ id: "call-1" }, bad]))));
    await expect(agentLoop(client, new RegisteredTools([tool]), "m", "read")).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])("length 截断，无论是否工具调用都拒绝（tools=%j）", async (hasTools) => {
    const execute = vi.spyOn(tool, "execute");
    const raw = hasTools ? toolCompletion(undefined, "length") : {
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
    };
    const client = await serve((_req, res) => res.end(JSON.stringify(raw)));
    await expect(agentLoop(client, new RegisteredTools([tool]), "m", "read")).rejects.toBeInstanceOf(ResponseError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { type: "function", function: { name: "read_file", arguments: "{}" } },
    { id: "bad", type: "function", function: { arguments: "{}" } },
    { id: "bad", type: "function", function: { name: "read_file" } },
    { id: "bad", type: "function", function: { name: "read_file", arguments: {} } },
    { id: "bad", type: "other", function: { name: "read_file", arguments: "{}" } },
  ])("缺失或错误的 HTTP 调用字段拒绝整条响应 %#", async (bad) => {
    const raw = toolCompletion();
    const message = raw.choices[0]?.message;
    const client = await serve((_req, res) => res.end(JSON.stringify({ choices: [{ message: {
      ...message, tool_calls: [...(message?.tool_calls ?? []), bad],
    } }] })));
    const execute = vi.spyOn(tool, "execute");
    await expect(agentLoop(client, new RegisteredTools([tool]), "m", "read")).rejects.toBeInstanceOf(ResponseError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("HTTP 第 8 次请求工具，验证 8 个请求、7 次真实文件执行和完整历史", async () => {
    let hits = 0;
    const execute = vi.spyOn(tool, "execute");
    const client = await serve((_req, res) => {
      hits++;
      res.end(JSON.stringify(toolCompletion()));
    });
    await expect(agentLoop(client, new RegisteredTools([tool]), "m", "read")).rejects.toMatchObject({ code: "loop_limit" });
    expect(hits).toBe(8);
    expect(execute).toHaveBeenCalledTimes(7);
  });
});
