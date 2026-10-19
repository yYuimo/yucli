/** adapters 内部的字节/SSE 边界；仅输出 data 文本，不理解模型或工具语义。 */
import { ResponseError } from "../../contracts/llm-client.js";

/**
 * 为一次 HTTP 响应保存 UTF-8 解码器、未完成行和当前事件的 data 行。
 * OpenCodeGoClient.stream 每次请求创建一个实例，不在请求之间复用状态。
 */
export class SseParser {
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
      return this.consume(this.decoder.decode(bytes, { stream: true }));
    } catch (error) {
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
      tail = this.decoder.decode();
    } catch {
      throw new ResponseError("流式响应以半截 UTF-8 结束。");
    }
    const events = this.consume(tail);
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
    this.buffer += text;
    const events: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        if (this.data.length) events.push(this.data.join("\n"));
        this.data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /u, ""));
      }
    }
    return events;
  }
}
