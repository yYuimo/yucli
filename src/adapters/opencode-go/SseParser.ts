/** adapters 内部的字节/SSE 边界；仅输出 data 文本，不理解模型或工具语义。 */
import { ResponseError } from "../../contracts/llm-client.js";

/**
 * 为一次 HTTP 响应保存 UTF-8 解码器、未完成行和当前事件的 data 行。
 * OpenCodeGoClient.stream 每次请求创建一个实例，不在请求之间复用状态。
 */
export class SseParser {
  // 三种状态分别处理不同边界：decoder 留半个 UTF-8 字符，buffer 留半行，data 留半个事件。
  // 网络一次 read 得到的块可能同时跨越这三种边界，不能直接逐块 JSON.parse。
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private data: string[] = [];

  /**
   * 接收 reader 提供的一块原始字节，返回本块补齐的所有 SSE data 事件。
   * 分片边界可落在汉字或 CRLF 中间；解码器和 buffer 保留尾部，不产生替换字符。
   * bytes 不被修改；非法 UTF-8 抛 ResponseError。这里只解析，不执行工具或打印。
   */
  push(bytes: Uint8Array): string[] {
    try {
      // stream:true 告诉 decoder 后面还有字节，例如一个汉字前两字节到了、第三字节未到时，
      // 暂存它而不是报错或产生替换字符。解码出的完整文字再交给按行处理的 consume。
      return this.consume(this.decoder.decode(bytes, { stream: true }));
    } catch (error) {
      // 已分类的 SSE 错误保留；decoder 自己的异常转换成不含原始字节的稳定错误。
      if (error instanceof ResponseError) throw error;
      throw new ResponseError("流式响应包含非法 UTF-8。");
    }
  }

  /**
   * 正常 EOF 时冲刷 UTF-8 尾部并检查事件完整性，供客户端结束读取时调用。
   * 返回最后补齐的事件；半截字符或缺少空行收尾的 data 事件抛 ResponseError。
   * 不替代 message_end 校验；后者由客户端和 assembler 负责。
   */
  finish(): string[] {
    let tail: string;
    try {
      // 无参数 decode 是最终 flush：此时不能再等待下一块，剩余半截 UTF-8 必须报错。
      tail = this.decoder.decode();
    } catch {
      throw new ResponseError("流式响应以半截 UTF-8 结束。");
    }

    // 冲刷得到的文字仍必须走相同的行/事件规则，不能绕过空行边界直接当作一个事件。
    const events = this.consume(tail);

    // data 非空表示读到了事件的一部分但还没有空行；buffer 非空可能是尚未结束的一行。
    // 尾部只有空白或一条未换行的注释可忽略，其余残留意味着 SSE 事件不完整。
    if (this.data.length || (this.buffer.trim() && !this.buffer.startsWith(":"))) {
      throw new ResponseError("流式响应的 SSE 事件不完整。");
    }
    return events;
  }

  /**
   * 把已解码的文字按行处理，遇空行才提交一个事件；push/finish 共用此步骤。
   * 多行 data 用换行连接，注释和其他 SSE 字段忽略；返回顺序保持网络顺序。
   * 只改变当前解析器的缓冲区，未完成行留待下一块，不接触业务历史。
   */
  private consume(text: string): string[] {
    // 先接上前一块的半行。一次调用可能得到零个事件，也可能一次补齐多个事件。
    this.buffer += text;
    const events: string[] = [];
    let newline: number;

    // 找到 \n 才处理完整行；若 \r 和 \n 分别在两块中，\r 会留在 buffer 等下一块。
    // 条件中的赋值保存本次换行位置，-1 表示剩余内容尚不足一行。
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      // 只去掉行末的一个 \r 以兼容 CRLF，不 trim 数据本身的空格。
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);

      if (!line) {
        // 空行结束一个 SSE 事件；多行 data 按协议用换行连接。
        // 只有心跳/其他字段的事件没有 data，不会产生交给 JSON 层的空事件。
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        // 去掉 data: 前缀及其后至多一个可选空格，保留正文其余空格。
        // 裸 data 行表示一个空 data 值；它与完全没有 data 的心跳事件不同。
        this.data.push(line.slice(5).replace(/^ /u, ""));
      }

      // 以 : 开头的心跳及 event:/id: 等非 data 字段不进入上述分支，直接忽略。
    }
    return events;
  }
}
