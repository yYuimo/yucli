import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { ReadFileTool } from "../src/adapters/filesystem/ReadFileTool.js";
import { AbortError } from "../src/contracts/llm-client.js";

// 内置 ESM 导出不可直接 spy；只包装 stat/open，其他文件 API 仍访问真实临时目录。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat), open: vi.fn(actual.open) };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

describe("ReadFileTool 路径、字节与编码边界", () => {
  let base: string;
  let root: string;
  let tool: ReadFileTool;

  beforeEach(async () => {
    vi.mocked(fs.stat).mockReset().mockImplementation(actualFs.stat);
    vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open);
    base = await mkdtemp(join(tmpdir(), "yucli-files-"));
    root = join(base, "work");
    await mkdir(root);
    tool = new ReadFileTool(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  it.each(["", "hello\n你好\r\n", "\ufeffBOM 保留"])("原文无损返回，包括空文件及 BOM %#", async (content) => {
    await writeFile(join(root, "file"), content);
    expect(await tool.execute({ path: "file" })).toEqual({ ok: true, content });
  });

  it.each([65536, 65537])("文件大小 %i 字节的明确边界", async (size) => {
    await writeFile(join(root, "file"), Buffer.alloc(size, 97));
    const result = await tool.execute({ path: "file" });
    expect(result.ok).toBe(size === 65536);
    if (result.ok) expect(Buffer.byteLength(result.content)).toBe(65536);
    else expect(result.content).toContain("file_too_large");
  });

  it("按 UTF-8 字节而非字符数限制", async () => {
    await writeFile(join(root, "file"), "中".repeat(22000));
    expect(await tool.execute({ path: "file" })).toMatchObject({ ok: false, content: expect.stringContaining("file_too_large") });
  });

  it("无效 UTF-8 不用替换字符继续成功", async () => {
    await writeFile(join(root, "file"), Buffer.from([0x61, 0xc3, 0x28]));
    expect(await tool.execute({ path: "file" })).toEqual({ ok: false, content: "[invalid_utf8] 文件不是有效 UTF-8 文本。" });
  });

  it.each(["", "  ", "/etc/passwd", "C:\\outside", "\\\\server\\share", "file\0bad", "../outside", "../../outside"])("拒绝非法/越界路径 %j", async (path) => {
    const result = await tool.execute({ path });
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain(root);
  });

  it("目录和不存在文件返回安全错误", async () => {
    await expect(tool.execute({ path: "." })).resolves.toMatchObject({ ok: false, content: expect.stringContaining("not_regular_file") });
    await expect(tool.execute({ path: "missing" })).resolves.toEqual({ ok: false, content: "[file_not_found] 文件不存在。" });
  });

  it("特殊文件在读取前拒绝，命名管道不会令命令等待写入者", async () => {
    execFileSync("mkfifo", [join(root, "pipe")]);
    const result = await tool.execute({ path: "pipe" });
    expect(result).toMatchObject({ ok: false, content: expect.stringContaining("not_regular_file") });
    expect(vi.mocked(fs.open)).not.toHaveBeenCalled();
  });

  it("允许根内符号链接，拒绝逃逸到相同前缀目录的链接", async () => {
    await writeFile(join(root, "file"), "inside");
    await symlink(join(root, "file"), join(root, "inside-link"));
    expect(await tool.execute({ path: "inside-link" })).toEqual({ ok: true, content: "inside" });

    const outside = join(base, "workspace");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "must not read");
    await symlink(outside, join(root, "escape"));
    expect(await tool.execute({ path: "escape/secret" })).toEqual({ ok: false, content: "[outside_workspace] 符号链接目标超出工作区。" });
  });

  it("先 stat 再 open；超大文件不打开", async () => {
    await writeFile(join(root, "file"), "text");
    const metadata = vi.mocked(fs.stat);
    const opening = vi.mocked(fs.open);
    expect((await tool.execute({ path: "file" })).ok).toBe(true);
    expect(metadata.mock.invocationCallOrder[0]).toBeLessThan(opening.mock.invocationCallOrder[0] ?? 0);

    await writeFile(join(root, "large"), Buffer.alloc(65537));
    opening.mockClear();
    expect((await tool.execute({ path: "large" })).ok).toBe(false);
    expect(opening).not.toHaveBeenCalled();
  });

  it("stat 后文件增长到超限仍失败，不截断成功", async () => {
    await writeFile(join(root, "file"), "small");
    const originalStat = actualFs.stat;
    vi.mocked(fs.stat).mockImplementationOnce(async (...args) => {
      const result = await originalStat(...args);
      await writeFile(join(root, "file"), Buffer.alloc(65537));
      return result;
    });
    expect(await tool.execute({ path: "file" })).toMatchObject({ ok: false, content: expect.stringContaining("file_too_large") });
  });

  it("权限错误摘要不含底层绝对路径或异常信息", async () => {
    await writeFile(join(root, "file"), "text");
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error(`${root} SECRET`), { code: "EACCES" }));
    expect(await tool.execute({ path: "file" })).toEqual({ ok: false, content: "[permission_denied] 没有读取文件的权限。" });
  });

  it("打开句柄后文件增长，最多读上限加 1 字节并拒绝成功返回", async () => {
    await writeFile(join(root, "file"), "small");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actualFs.open(...args);
      const metadata = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
        const info = await metadata();
        await writeFile(join(root, "file"), Buffer.alloc(100000));
        return info;
      });
      return handle;
    });
    expect(await tool.execute({ path: "file" })).toMatchObject({ ok: false, content: expect.stringContaining("file_too_large") });
  });

  it("调用前和读取中取消均抛稳定错误，读取中取消关闭句柄", async () => {
    await expect(tool.execute({ path: "file" }, AbortSignal.abort())).rejects.toBeInstanceOf(AbortError);
    await writeFile(join(root, "file"), "text");
    const controller = new AbortController();
    const originalOpen = actualFs.open;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      close = vi.spyOn(handle, "close");
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        const value = await read(...readArgs);
        controller.abort();
        return value;
      });
      return handle;
    });
    await expect(tool.execute({ path: "file" }, controller.signal)).rejects.toBeInstanceOf(AbortError);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
