import { resolve } from "node:path";
// as 在 import 中是重命名：避免 config 函数名与本项目配置对象混淆。
import { config as loadDotenv } from "dotenv";
import { ConfigError } from "../../contracts/llm-client.js";

/** adapters 层读取并校验后的配置，由 bootstrap 传给模型客户端。 */
export interface RuntimeConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface ConfigOptions {
  // 测试可传临时目录和独立环境变量；CLI 不传时使用当前进程的值。
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 读取一次命令所需的模型配置，补齐默认值，并在请求前拒绝非法配置。
 * CLI 在参数检查通过后调用它，用返回结果创建客户端和选择模型。
 * 执行顺序：复制环境变量 → 读取当前目录 .env → 校验密钥、端点和超时 → 返回配置。
 * 进程环境变量优先于 .env；缺少 .env 本身不是错误。
 *
 * @param options 可覆盖读取目录 cwd 和环境变量 env，供测试隔离配置来源；
 * 不传时使用当前工作目录和 process.env。
 * @returns 可直接供 CLI 使用的 apiKey、baseUrl、model、timeoutMs。
 * @throws ConfigError 文件读取失败（除文件不存在外），或配置值不合法时抛出。
 * 只读取文件和环境变量，不修改全局 process.env，不发网络请求。
 */
export function loadConfig(options: ConfigOptions = {}): RuntimeConfig {
  // = {} 允许调用 loadConfig()；?? 只在左侧为 null/undefined 时取右侧。
  // ... 浅拷贝环境变量，让 dotenv 写入副本，不修改全局 process.env。
  const env = { ...(options.env ?? process.env) };
  const result = loadDotenv({
    // 只读启动目录的 .env，不向父目录搜索；进程环境变量包括空值都优先。
    path: resolve(options.cwd ?? process.cwd(), ".env"),
    processEnv: env,
    override: false,
    quiet: true,
  });
  // 没有 .env（ENOENT）可以继续使用环境变量；其他文件读取错误必须报告。
  // as 是类型断言，只帮助编译器访问 code，不会转换异常或执行格式校验。
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ENOENT") {
    throw new ConfigError("无法读取当前工作目录的 .env。");
  }

  // ?. 可选链：变量不存在时返回 undefined，不调用 trim；存在时去掉两端空白。
  // !apiKey 同时拒绝 undefined 和空字符串，因此必填项不能使用空白值。
  const apiKey = env.OPENCODE_GO_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("缺少 OPENCODE_GO_API_KEY。");
  // 正则中的 [^...] 表示排除集合：拒绝空格、换行、非 ASCII 等头部非法内容。
  if (/[^\x21-\x7e]/u.test(apiKey)) {
    throw new ConfigError("OPENCODE_GO_API_KEY 必须是可用于 HTTP 请求头的可见 ASCII 字符。");
  }

  // || 与 ?? 不同：空字符串也会采用默认值。可选配置允许以空白表示默认。
  const baseUrl = env.OPENCODE_GO_BASE_URL?.trim() || "https://opencode.ai/zen/go/v1";
  let url: URL;
  try {
    // new URL 做语法解析，后续 if 再检查本项目允许的协议和 URL 组成。
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

  // 环境变量始终是字符串，转成数字前后都要检查，避免接受小数、NaN 或科学记数法。
  // 上限来自 Node 定时器范围，超出范围会影响超时行为。
  const timeoutText = env.YUCLI_REQUEST_TIMEOUT_MS?.trim() || "120000";
  const timeoutMs = Number(timeoutText);
  if (!/^\d+$/u.test(timeoutText) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new ConfigError("YUCLI_REQUEST_TIMEOUT_MS 必须是 1 至 2147483647 的整数毫秒数。");
  }

  return {
    // 对象属性简写 apiKey 等价于 apiKey: apiKey。
    apiKey,
    // 去掉末尾一个或多个 /，客户端再统一追加 /chat/completions。
    baseUrl: url.href.replace(/\/+$/u, ""),
    model: env.OPENCODE_GO_MODEL?.trim() || "deepseek-v4-flash",
    timeoutMs,
  };
}
