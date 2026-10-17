import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { ConfigError } from "../errors.js";

export interface RuntimeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface ConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// 只读取启动目录的 .env，已有环境变量（包括空字符串）优先。
export function loadConfig(options: ConfigOptions = {}): RuntimeConfig {
  const env = { ...(options.env ?? process.env) };
  const result = loadDotenv({
    path: resolve(options.cwd ?? process.cwd(), ".env"),
    processEnv: env,
    override: false,
    quiet: true,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new ConfigError("无法读取当前工作目录的 .env。");
  }

  const apiKey = env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("缺少 OPENCODE_GO_API_KEY。");
  if (/[^\x21-\x7e]/u.test(apiKey)) {
    throw new ConfigError("OPENCODE_GO_API_KEY 必须是可用于 HTTP 请求头的可见 ASCII 字符。");
  }

  const baseUrl = env.OPENCODE_GO_BASE_URL?.trim() || "https://opencode.ai/zen/go/v1";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError("OPENCODE_GO_BASE_URL 必须是有效的 HTTP(S) URL。");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new ConfigError("OPENCODE_GO_BASE_URL 只支持无凭证、查询参数和片段的 HTTP(S) URL。");
  }

  const timeoutText = env.YUCLI_REQUEST_TIMEOUT_MS?.trim() || "120000";
  const timeoutMs = Number(timeoutText);
  if (!/^\d+$/u.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new ConfigError("YUCLI_REQUEST_TIMEOUT_MS 必须是 1 至 2147483647 的整数毫秒数。");
  }

  return {
    apiKey,
    baseUrl: url.href.replace(/\/+$/u, ""),
    model: env.OPENCODE_GO_MODEL?.trim() || "deepseek-v4-flash",
    timeoutMs,
  };
}
