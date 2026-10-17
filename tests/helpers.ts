import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";

export async function startServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(Buffer.from(part as Uint8Array));
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

export function completion(content = "你好！") {
  return { choices: [{ message: { role: "assistant", content, reasoning_content: "不应显示的推理" } }] };
}
