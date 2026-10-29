/**
 * adapters 层的独立 JSON 对象前缀识别器，供无 LF 的最后一行分类。
 * 不依赖 JSON.parse 的错误文字，也不解释业务字段；完整 JSON 仍须通过 schema/语义校验。
 */

/** complete 是完整对象；incomplete 表示只追加字节就能补成对象；invalid 不能靠追加修复。 */
export type JsonPrefixKind = "complete" | "incomplete" | "invalid";

/** UTF-8 检查结果；text 只含完整码点，partial 表示末尾尚缺合法后续字节。 */
interface Utf8Prefix {
  /** 已完成 UTF-8 序列对应的文字，不包含替换字符或残缺序列。 */
  text: string;
  /** true 仅表示最后一个码点缺后续字节；合法性还取决于 JSON 是否处于字符串内容。 */
  partial: boolean;
}

/**
 * 检查每个 UTF-8 序列，供前缀分类调用；输入为一整条物理尾行的字节。
 * 返回完整码点文本及尾部残缺标记；过长编码、代理区、越界和错误 continuation 返回 null。
 * 先限制第二字节范围，避免把必然非法的 E0 80、ED A0 等当作可完成残片。
 */
function decodeUtf8Prefix(bytes: Uint8Array): Utf8Prefix | null {
  let position = 0;

  while (position < bytes.length) {
    const first = bytes[position]!;
    if (first <= 0x7f) {
      position++;
      continue;
    }

    const width = first >= 0xc2 && first <= 0xdf ? 2
      : first >= 0xe0 && first <= 0xef ? 3
      : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (!width) return null;

    for (let index = 1; index < width; index++) {
      if (position + index === bytes.length) {
        // 只解码前面的完整码点，不让 TextDecoder 用替换字符掩盖残片。
        return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, position)), partial: true };
      }

      const next = bytes[position + index]!;
      const minimum = index === 1 && first === 0xe0 ? 0xa0 : index === 1 && first === 0xf0 ? 0x90 : 0x80;
      const maximum = index === 1 && first === 0xed ? 0x9f : index === 1 && first === 0xf4 ? 0x8f : 0xbf;
      if (next < minimum || next > maximum) return null;
    }

    position += width;
  }

  return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), partial: false };
}

/** 每个嵌套容器有独立语法阶段，区分空容器与逗号后不能直接结束的状态。 */
type Frame =
  | { kind: "object"; stage: "first_key" | "key" | "colon" | "value" | "separator" }
  | { kind: "array"; stage: "first_value" | "value" | "separator" };

/** 数字 token 的前缀状态；dot/exponent/sign 还必须追加数字，zero 后不能直接再跟数字。 */
type NumberStage = "minus" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "sign" | "digits";

/**
 * 单次识别的语法状态，由 classifyJsonObjectPrefix 创建；迭代栈避免递归深度限制。
 * 它只判断语法可完成性，不构造业务对象、不读写文件。
 */
class PrefixParser {
  private readonly stack: Frame[] = [];
  private started = false;
  private complete = false;
  private mode: "grammar" | "string" | "escape" | "unicode" | "number" | "literal" = "grammar";
  private stringIsKey = false;
  private unicodeRemaining = 0;
  private number: NumberStage = "integer";
  private literal = "";
  private literalPosition = 0;

  /**
   * 消费完整码点文本并结合 UTF-8 尾部状态分类；由导出函数在编码检查后调用。
   * 任何不可能由追加修复的字符立即 invalid；EOF 的可达语法状态才是 incomplete。
   */
  classify(input: Utf8Prefix): JsonPrefixKind {
    for (const character of input.text) {
      if (!this.consume(character)) return "invalid";
    }

    // 非 ASCII 码点只能作为字符串普通内容；例如开放字符串里的半个“中”可补齐，
    // 但冒号后、反斜杠后或 \u 的十六进制区内出现同样残片都不合法。
    if (input.partial) return this.mode === "string" ? "incomplete" : "invalid";
    return this.complete ? "complete" : "incomplete";
  }

  /**
   * 消费一个字符并推进 token/容器状态；false 表示已形成不可恢复的语法错误。
   * 数字在分隔符到来时结束，再由 grammar 处理同一个分隔符，不能丢掉右括号。
   */
  private consume(character: string): boolean {
    if (this.mode === "string") {
      if (character === '"') {
        this.mode = "grammar";
        if (this.stringIsKey) {
          const frame = this.stack.at(-1)!;
          if (frame.kind === "object") frame.stage = "colon";
        }
      } else if (character === "\\") {
        this.mode = "escape";
      } else if (character.codePointAt(0)! < 0x20) {
        return false;
      }
      return true;
    }

    if (this.mode === "escape") {
      if (character === "u") {
        this.mode = "unicode";
        this.unicodeRemaining = 4;
        return true;
      }
      if (!'"\\/bfnrt'.includes(character)) return false;
      this.mode = "string";
      return true;
    }

    if (this.mode === "unicode") {
      if (!/^[0-9a-fA-F]$/.test(character)) return false;
      if (--this.unicodeRemaining === 0) this.mode = "string";
      return true;
    }

    if (this.mode === "literal") {
      if (character !== this.literal[this.literalPosition]) return false;
      if (++this.literalPosition === this.literal.length) this.mode = "grammar";
      return true;
    }

    if (this.mode === "number") {
      const next = this.nextNumber(character);
      if (next) {
        this.number = next;
        return true;
      }

      // 完整数字可由空白、逗号、右括号终止；半个指数或小数点不能被分隔符“补好”。
      if (!["zero", "integer", "fraction", "digits"].includes(this.number)) return false;
      this.mode = "grammar";
    }

    return this.grammar(character);
  }

  /** 根据数字当前阶段和下一字符选择后继阶段；null 交给调用方判断终止还是错误。 */
  private nextNumber(character: string): NumberStage | null {
    const digit = character >= "0" && character <= "9";
    switch (this.number) {
      case "minus": return character === "0" ? "zero" : digit ? "integer" : null;
      case "zero": return character === "." ? "dot" : /[eE]/.test(character) ? "exponent" : null;
      case "integer": return digit ? "integer" : character === "." ? "dot" : /[eE]/.test(character) ? "exponent" : null;
      case "dot": return digit ? "fraction" : null;
      case "fraction": return digit ? "fraction" : /[eE]/.test(character) ? "exponent" : null;
      case "exponent": return /[+-]/.test(character) ? "sign" : digit ? "digits" : null;
      case "sign": return digit ? "digits" : null;
      case "digits": return digit ? "digits" : null;
    }
  }

  /**
   * 处理 token 之间的对象/数组语法；根只能为对象，完成后仅能追加 JSON 空白。
   * stage 在值开始时推进，嵌套容器完成前始终由栈顶消费字符。
   */
  private grammar(character: string): boolean {
    if (" \t\r\n".includes(character)) return true;
    if (this.complete) return false;
    if (!this.started) {
      if (character !== "{") return false;
      this.started = true;
      this.stack.push({ kind: "object", stage: "first_key" });
      return true;
    }

    const frame = this.stack.at(-1)!;
    if (frame.kind === "object" && (frame.stage === "first_key" || frame.stage === "key")) {
      if (character === "}" && frame.stage === "first_key") return this.closeContainer();
      if (character !== '"') return false;
      this.stringIsKey = true;
      this.mode = "string";
      return true;
    }

    if (frame.stage === "colon") {
      if (character !== ":") return false;
      frame.stage = "value";
      return true;
    }

    if (frame.stage === "separator") {
      if (character === (frame.kind === "object" ? "}" : "]")) return this.closeContainer();
      if (character !== ",") return false;
      frame.stage = frame.kind === "object" ? "key" : "value";
      return true;
    }

    if (frame.kind === "array" && frame.stage === "first_value" && character === "]") {
      return this.closeContainer();
    }

    // 到这里必须开始一个值。父容器先记为“等待分隔符”，子容器/字符串独立消费。
    frame.stage = "separator";
    if (character === "{" || character === "[") {
      this.stack.push(character === "{" ? { kind: "object", stage: "first_key" } : { kind: "array", stage: "first_value" });
    } else if (character === '"') {
      this.stringIsKey = false;
      this.mode = "string";
    } else if (character === "-" || /^[0-9]$/.test(character)) {
      this.mode = "number";
      this.number = character === "-" ? "minus" : character === "0" ? "zero" : "integer";
    } else if ("tfn".includes(character)) {
      this.literal = character === "t" ? "true" : character === "f" ? "false" : "null";
      this.literalPosition = 1;
      this.mode = "literal";
    } else {
      return false;
    }
    return true;
  }

  /** 关闭已经匹配的栈顶容器；根对象出栈后标记 complete，不接受第二个值。 */
  private closeContainer(): true {
    this.stack.pop();
    if (this.stack.length === 0) this.complete = true;
    return true;
  }
}

/**
 * 判断一条无 LF 尾行是否为完整/可补全/非法 JSON 对象，扫描器和测试直接调用。
 * 输入保留原始字节，先严格检查 UTF-8，再检查 JSON 的每个语法阶段；不抛解析异常。
 * incomplete 仅证明语法可追加完成，不证明补完后业务 schema 或引用合法。
 */
export function classifyJsonObjectPrefix(bytes: Uint8Array): JsonPrefixKind {
  const decoded = decodeUtf8Prefix(bytes);
  return decoded ? new PrefixParser().classify(decoded) : "invalid";
}
