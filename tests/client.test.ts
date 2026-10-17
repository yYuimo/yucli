import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeGoClient } from "../src/llm/OpenCodeGoClient.js";
import { runPrompt } from "../src/app/runPrompt.js";
import { AbortError, RequestError, ResponseError } from "../src/errors.js";
import { completion, readJson, startServer } from "./helpers.js";

const apiKey = "test-secret-key-123456";
const request = { model: "deepseek-v4-flash", messages: [{ role: "user" as const, content: "你好" }] };

describe("OpenCodeGoClient 真实 HTTP 传输", () => {
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  async function serve(handler: Parameters<typeof startServer>[0], timeoutMs = 2000) {
    const server = await startServer(handler);
    servers.push(server);
    return new OpenCodeGoClient({ baseUrl: server.baseUrl + "/", apiKey, timeoutMs });
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    vi.restoreAllMocks();
  });

  it("应用服务发送正确请求，保留文本与 token 用量，不暴露 reasoning", async () => {
    let captured: unknown;
    let method: string | undefined;
    let url: string | undefined;
    let headers: unknown;
    const client = await serve(async (req, res) => {
      method = req.method;
      url = req.url;
      headers = req.headers;
      captured = await readJson(req);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ...completion(" 原始回答\n"), usage: { prompt_tokens: 12, completion_tokens: 7 } }));
    });
    const prompt = " 你好\n世界 ";
    const result = await runPrompt(client, request.model, prompt);
    expect(method).toBe("POST");
    expect(url).toBe("/v1/chat/completions");
    expect(headers).toMatchObject({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" });
    expect(headers).toMatchObject({ "x-opencode-session": expect.stringMatching(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u) });
    expect(captured).toEqual({ model: request.model, messages: [{ role: "user", content: prompt }], stream: false });
    expect(result).toEqual({ message: { role: "assistant", content: " 原始回答\n" }, usage: { inputTokens: 12, outputTokens: 7 } });
  });

  it("不修改传入请求或消息", async () => {
    const client = await serve((_req, res) => res.end(JSON.stringify(completion())));
    const input = structuredClone(request);
    Object.freeze(input.messages[0]);
    Object.freeze(input.messages);
    Object.freeze(input);
    await client.complete(input);
    expect(input).toEqual(request);
  });

  it("独立请求生成不同的服务路由 ID", async () => {
    const ids: unknown[] = [];
    const client = await serve((req, res) => {
      ids.push(req.headers["x-opencode-session"]);
      res.end(JSON.stringify(completion()));
    });
    await client.complete(request);
    await client.complete(request);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("HTTP 错误保留状态码，诊断限长且脱敏", async () => {
    const client = await serve((_req, res) => {
      res.writeHead(403);
      res.end(`echo ${apiKey}\nAuthorization: Bearer ${apiKey}\n\u001b[31m${"错".repeat(1000)}`);
    });
    const error = await client.complete(request).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: "http", status: 403 });
    const detail = error as RequestError;
    expect(Buffer.byteLength(detail.responseSummary ?? "")).toBeLessThanOrEqual(512);
    expect(detail.message).not.toContain(apiKey);
    expect(detail.message).not.toMatch(/Authorization|Bearer/u);
    expect(detail.message).not.toContain("\u001b");
  });

  it("截断到密钥中间时也隐藏前缀", async () => {
    const client = await serve((_req, res) => {
      res.writeHead(500);
      res.end("x".repeat(503) + apiKey);
    });
    const error = await client.complete(request).catch((error: unknown) => error) as RequestError;
    expect(error.responseSummary).not.toContain(apiKey.slice(0, 9));
  });

  it("错误响应读到 512 字节便结束，不等待服务端关闭", async () => {
    const client = await serve((_req, res) => {
      res.writeHead(429);
      res.write("x".repeat(1024));
    }, 500);
    await expect(client.complete(request)).rejects.toMatchObject({ code: "http", status: 429 });
  });

  it.each([
    {}, { choices: [] }, { choices: [{ message: { role: "user", content: "text" } }] },
    { choices: [{ message: { role: "assistant", content: null } }] },
    { choices: [{ message: { role: "assistant", content: "   " } }] },
    { ...completion(), usage: { prompt_tokens: -1 } },
    { ...completion(), usage: { completion_tokens: "4" } },
  ])("拒绝非法成功响应 %#", async (body) => {
    const client = await serve((_req, res) => res.end(JSON.stringify(body)));
    await expect(client.complete(request)).rejects.toBeInstanceOf(ResponseError);
  });

  it("拒绝错误 JSON，且不把原始响应写入错误", async () => {
    const client = await serve((_req, res) => res.end(`not-json ${apiKey}`));
    await expect(client.complete(request)).rejects.toThrow("未返回有效 JSON");
  });

  it.each(["headers", "success-body", "error-body"])("超时覆盖 %s 等待阶段", async (stage) => {
    const client = await serve((_req, res) => {
      if (stage !== "headers") {
        res.writeHead(stage === "error-body" ? 503 : 200);
        res.flushHeaders();
        res.write("{");
      }
    }, 100);
    await expect(client.complete(request)).rejects.toMatchObject({ code: "timeout" });
  });

  it("取消传给底层请求，后续请求使用独立控制器", async () => {
    let count = 0;
    const client = await serve((_req, res) => {
      count++;
      if (count > 1) res.end(JSON.stringify(completion()));
    });
    const controller = new AbortController();
    const promise = client.complete(request, controller.signal);
    const settled = expect(promise).rejects.toBeInstanceOf(AbortError);
    await vi.waitFor(() => expect(count).toBe(1));
    controller.abort(new Error(apiKey));
    await settled;
    await expect(client.complete(request)).resolves.toMatchObject({ message: { content: "你好！" } });
  });

  it("已取消的 signal 不发起 HTTP 请求并清理监听器与定时器", async () => {
    let count = 0;
    const client = await serve((_req, res) => { count++; res.end(); });
    const controller = new AbortController();
    controller.abort();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    await expect(client.complete(request, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(count).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(clear).toHaveBeenCalled();
  });

  it("网络断开转换为稳定错误", async () => {
    const client = await serve((req) => req.socket.destroy());
    await expect(client.complete(request)).rejects.toMatchObject({ code: "network" });
  });

  it("拒绝重定向，不向重定向目标发送凭证", async () => {
    let targetHits = 0;
    const target = await startServer((_req, res) => { targetHits++; res.end(JSON.stringify(completion())); });
    servers.push(target);
    const client = await serve((_req, res) => {
      res.writeHead(307, { Location: `${target.baseUrl}/chat/completions` });
      res.end();
    });
    await expect(client.complete(request)).rejects.toMatchObject({ code: "network" });
    expect(targetHits).toBe(0);
  });
});
