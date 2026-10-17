import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loadConfig.js";
import { ConfigError } from "../src/errors.js";

describe("配置加载", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "yucli-config-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("无 .env 时允许纯环境变量和默认配置", () => {
    expect(loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: "test-key" } })).toEqual({
      apiKey: "test-key", baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4-flash", timeoutMs: 120000,
    });
  });

  it("加载当前目录 .env，环境变量优先且不污染 process.env", async () => {
    await writeFile(join(cwd, ".env"), "OPENCODE_GO_API_KEY=file-key\nOPENCODE_GO_MODEL=file-model\nOPENCODE_GO_BASE_URL=https://example.com/v1///\n");
    const original = process.env.OPENCODE_GO_API_KEY;
    expect(loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: "env-key" } })).toEqual({
      apiKey: "env-key", baseUrl: "https://example.com/v1", model: "file-model", timeoutMs: 120000,
    });
    expect(process.env.OPENCODE_GO_API_KEY).toBe(original);
    expect(() => loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: "" } })).toThrow(ConfigError);
  });

  it.each([undefined, "", "   ", "key\nsecret", "密钥"])("拒绝缺失或非法密钥 %j", (key) => {
    expect(() => loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: key } })).toThrow(ConfigError);
  });

  it.each(["invalid", "file:///tmp/model", "https://user:pass@example.com", "https://example.com?key=secret", "https://example.com/#token"])("拒绝非法端点 %s", (baseUrl) => {
    expect(() => loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: "test", OPENCODE_GO_BASE_URL: baseUrl } })).toThrow(ConfigError);
  });

  it.each(["0", "-1", "1.5", "NaN", "1e3", "Infinity", "2147483648"])("拒绝非法超时 %s", (timeout) => {
    expect(() => loadConfig({ cwd, env: { OPENCODE_GO_API_KEY: "test", YUCLI_REQUEST_TIMEOUT_MS: timeout } })).toThrow(ConfigError);
  });

  it("接受自定义模型、HTTP 测试端点和超时", () => {
    expect(loadConfig({ cwd, env: {
      OPENCODE_GO_API_KEY: "test", OPENCODE_GO_BASE_URL: "http://localhost:8080/v1/",
      OPENCODE_GO_MODEL: "custom-model", YUCLI_REQUEST_TIMEOUT_MS: "250",
    } })).toMatchObject({ model: "custom-model", baseUrl: "http://localhost:8080/v1", timeoutMs: 250 });
  });
});
