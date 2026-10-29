import { fork, execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLockAdapter } from "../src/adapters/session/SessionLockAdapter.js";
import { preflightLock } from "../src/adapters/session/lockPlatform.js";
import type { NativeFlock } from "../src/adapters/session/lockPlatform.js";
import type { SessionLock } from "../src/contracts/session-lock.js";

import { completion, completionSse, startServer } from "./helpers.js";

const require = createRequire(import.meta.url);
const loadNative = () => require("fs-ext") as NativeFlock;
const childEntry = fileURLToPath(new URL("./fixtures/session-lock-child.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
const built = pathToFileURL(fileURLToPath(new URL("../dist/adapters/session/SessionLockAdapter.js", import.meta.url))).href;
const exec = promisify(execFile);
let directory: string;
let root: string;
const locks: SessionLock[] = [];
const children: ReturnType<typeof fork>[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yucli-lock-"));
  root = join(directory, ".yucli");
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const lock of locks.splice(0)) await lock.release();
  await rm(directory, { recursive: true, force: true });
});

function id() { return randomUUID(); }
async function acquire(sessionId: string, adapter = new SessionLockAdapter({ storageRoot: root })) {
  const lock = await adapter.acquire(sessionId);
  locks.push(lock);
  return lock;
}
async function childProcess() {
  const child = fork(childEntry, [], {
    execPath: process.execPath, execArgv: ["--import", tsx],
    env: { PATH: process.env.PATH, YUCLI_LOCK_ROOT: root, YUCLI_LOCK_MODULE: built },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  let sequence = 0;
  const replies = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message: { ready?: boolean; requestId: number; value: unknown; error?: unknown }) => {
      if (message.ready) { resolve(); return; }
      const pending = replies.get(message.requestId);
      replies.delete(message.requestId);
      if (message.error) pending?.reject(message.error);
      else pending?.resolve(message.value);
    });
    child.on("error", reject);
    child.on("exit", () => {
      reject(new Error("child exited before ready"));
      for (const pending of replies.values()) pending.reject(new Error("child exited before response"));
    });
  });
  await ready;
  return {
    child,
    request(action: string, sessionId: string) {
      const requestId = ++sequence;
      return new Promise<unknown>((resolve, reject) => {
        replies.set(requestId, { resolve, reject });
        child.send({ action, sessionId, requestId });
      });
    },
  };
}

// 观察 macOS 的真实进程状态，不能发送 SIGSTOP 后 sleep 一段时间就假定已经停住。
async function waitStopped(pid: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { stdout } = await exec("/bin/ps", ["-o", "state=", "-p", String(pid)]);
    if (stdout.trim().startsWith("T")) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("SIGSTOP state not observed");
}

describe("T2 稳定 flock：真实目标平台、原生依赖与副作用边界", () => {
  it("构造不加载 native；预检按需加载且不创建根目录", async () => {
    const loader = vi.fn(loadNative);
    const adapter = new SessionLockAdapter({ storageRoot: root, loadNative: loader });
    expect(loader).not.toHaveBeenCalled();
    await adapter.preflight();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { platform: "linux", arch: "arm64", node: "24.14.0" },
    { platform: "darwin", arch: "x64", node: "24.14.0" },
    { platform: "darwin", arch: "arm64", node: "24.14.1" },
    { platform: "darwin", arch: "arm64", node: "26.3.0" },
  ])("未支持环境在 mkdir/native 前拒绝：%j", async (runtime) => {
    const loader = vi.fn(loadNative);
    const adapter = new SessionLockAdapter({ storageRoot: root, runtime, loadNative: loader });
    await expect(adapter.acquire(id())).rejects.toMatchObject({ code: "platform_unsupported" });
    expect(loader).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([undefined, {}, { flock: 3 }, "throws"])("加载失败明确为 lock_unavailable，无 mkdir/无锁降级 %#", async (value) => {
    const adapter = new SessionLockAdapter({ storageRoot: root, loadNative: () => {
      if (value === "throws") throw new Error("native ABI SECRET");
      return value;
    } });
    await expect(adapter.acquire(id())).rejects.toMatchObject({ code: "lock_unavailable" });
    expect(await adapter.probe(id())).toBe("unknown");
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["server:/share on / (nfs)", "//server/share on / (smbfs)", "unrecognized mount output"])("非本地/未知挂载在副作用前拒绝 %#", async (mounts) => {
    const adapter = new SessionLockAdapter({ storageRoot: root, readMounts: async () => mounts });
    await expect(adapter.acquire(id())).rejects.toMatchObject({ code: "platform_unsupported" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("嵌套远程挂载覆盖 local 根，按路径段判断而非前缀", async () => {
    const local = "/dev/disk on / (apfs, local)";
    const realDirectory = await import("node:fs/promises").then((fs) => fs.realpath(directory));
    await expect(preflightLock(root, { readMounts: async () => `${local}\nserver:/share on ${realDirectory} (nfs)` })).rejects.toMatchObject({ code: "platform_unsupported" });
    await preflightLock(root, { readMounts: async () => `${local}\nserver:/share on ${realDirectory}-other (nfs)` });
    expect(await readdir(directory)).toEqual([]);
  });

  it("锁能力失败不能用目录占位或无锁成功；失败后关闭 fd 并可重新申请", async () => {
    const sessionId = id();
    const adapter = new SessionLockAdapter({ storageRoot: root, loadNative: () => ({
      flock(_fd: number, _mode: string, callback: (error: NodeJS.ErrnoException) => void) {
        callback(Object.assign(new Error("not supported"), { code: "ENOTSUP" }));
      },
    }) });
    await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "lock_unavailable" });
    expect((await lstat(join(root, "locks", `${sessionId}.lock`))).isFile()).toBe(true);
    await acquire(sessionId);
  });

  it("只读 probe 缺文件/根返回 unknown，不创建任何路径", async () => {
    const adapter = new SessionLockAdapter({ storageRoot: root });
    expect(await adapter.probe(id())).toBe("unknown");
    expect(await readdir(directory)).toEqual([]);
  });

  it("进程内不同实例/并发重复申请只交付一个句柄，正常释放保留 inode/权限/内容", async () => {
    const adapter = new SessionLockAdapter({ storageRoot: root });
    const sessionId = id();
    const held = acquire(sessionId, adapter);
    await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "session_busy" });
    const lock = await held;
    await expect(new SessionLockAdapter({ storageRoot: root }).acquire(sessionId)).rejects.toMatchObject({ code: "session_busy" });
    expect(await adapter.probe(sessionId)).toBe("busy");
    const path = join(root, "locks", `${sessionId}.lock`);
    await writeFile(path, "stable sidecar, not a PID");
    const before = await lstat(path);
    expect(before.mode & 0o777).toBe(0o600);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, "locks"))).mode & 0o777).toBe(0o700);
    await lock.assertOwnership();
    const firstClose = lock.release();
    expect(lock.release()).toBe(firstClose);
    await firstClose;
    const after = await lstat(path);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await readFile(path, "utf8")).toBe("stable sidecar, not a PID");
    expect(await adapter.probe(sessionId)).toBe("available");
    await acquire(sessionId);
  });

  it("flock 回调未 settle 时不关闭 fd/撤销登记，settle 后才可释放（T2 的 D06 边界）", async () => {
    const sessionId = id();
    const native = loadNative();
    let finish!: () => void;
    let signalHeld!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const adapter = new SessionLockAdapter({ storageRoot: root, loadNative: () => ({
      flock(fd: number, mode: "exnb" | "shnb", callback: (error: NodeJS.ErrnoException | null) => void) {
        native.flock(fd, mode, (error) => {
          if (error) { callback(error); return; }
          finish = () => callback(null);
          signalHeld();
        });
      },
    }) });
    const acquisition = acquire(sessionId, adapter);
    await held;
    try {
      const other = await childProcess();
      await expect(other.request("acquire", sessionId)).rejects.toMatchObject({ code: "session_busy" });
      await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "session_busy" });
      expect(await other.request("probe", sessionId)).toBe("busy");
    } finally {
      finish();
      await (await acquisition).release();
    }
    await acquire(sessionId);
  });

  it("native 实际被阻止加载时，import adapter、help 与 --prompt 仍不加载它或创建存储", async () => {
    const hook = join(directory, "block-native.mjs");
    const attempts = join(directory, "native-attempts.txt");
    await writeFile(hook, `
      import Module from 'node:module';
      import { writeFileSync } from 'node:fs';
      const original = Module._load;
      let count = 0;
      Module._load = function(id, ...args) {
        if (id === 'fs-ext') { count++; throw new Error('native deliberately unavailable'); }
        return original.call(this, id, ...args);
      };
      process.on('exit', () => writeFileSync(${JSON.stringify(attempts)}, String(count)));
      await import(${JSON.stringify(built)});
    `);
    const server = await startServer((_req, res) => res.end(completionSse(completion("compatible"))));
    try {
      for (const args of [["--help"], ["--prompt", "hi"]]) {
        const child = spawn(process.execPath, ["--import", hook, fileURLToPath(new URL("../dist/bootstrap/cli.js", import.meta.url)), ...args], {
          cwd: directory, env: { PATH: process.env.PATH, HOME: directory,
            OPENCODE_GO_API_KEY: "fake-key", OPENCODE_GO_BASE_URL: server.baseUrl }, stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        const [code] = await once(child, "close");
        expect(code).toBe(0);
        expect(stderr).toBe("");
        expect(stdout).toContain(args[0] === "--help" ? "--prompt" : "compatible");
        expect(await readFile(attempts, "utf8")).toBe("0");
        await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await server.close(); }
  });

  it("非法 sessionId 拒绝路径穿越；现有宽权限根不 chmod", async () => {
    const adapter = new SessionLockAdapter({ storageRoot: root });
    await expect(adapter.acquire("../escape")).rejects.toMatchObject({ code: "invalid_identity" });
    expect(await readdir(directory)).toEqual([]);
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    await expect(adapter.acquire(id())).rejects.toMatchObject({ code: "permission_denied" });
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
    expect(await readdir(root)).toEqual([]);
  });

  it("受管锁目录/锁文件的 symlink 拒绝，不跟随或改写目标", async () => {
    const target = join(directory, "outside");
    await mkdir(target, { mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    await symlink(target, join(root, "locks"));
    const adapter = new SessionLockAdapter({ storageRoot: root });
    await expect(adapter.acquire(id())).rejects.toMatchObject({ code: "permission_denied" });
    expect(await readdir(target)).toEqual([]);
    await rm(join(root, "locks"));
    await mkdir(join(root, "locks"), { mode: 0o700 });
    const sessionId = id();
    const file = join(target, "unchanged");
    await writeFile(file, "original", { mode: 0o600 });
    await symlink(file, join(root, "locks", `${sessionId}.lock`));
    await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "permission_denied" });
    expect(await readFile(file, "utf8")).toBe("original");
  });

  it("取锁后复核 inode：取得 flock 期间路径被替换则拒绝交付", async () => {
    const sessionId = id();
    const path = join(root, "locks", `${sessionId}.lock`);
    const native = loadNative();
    const adapter = new SessionLockAdapter({ storageRoot: root, loadNative: () => ({
      flock(fd: number, mode: "exnb" | "shnb", callback: (error: NodeJS.ErrnoException | null) => void) {
        native.flock(fd, mode, (error) => {
          if (error) { callback(error); return; }
          void (async () => {
            await rename(path, `${path}.old`);
            await writeFile(path, "replacement", { mode: 0o600 });
          })().then(() => callback(null), callback);
        });
      },
    }) });
    await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "ownership_lost" });
    await acquire(sessionId);
  });

  it("运行中路径替换为 ownership_lost，保持故障；释放不删除新/旧 inode", async () => {
    const sessionId = id();
    const lock = await acquire(sessionId);
    const path = join(root, "locks", `${sessionId}.lock`);
    await rename(path, `${path}.old`);
    await writeFile(path, "replacement", { mode: 0o600 });
    await expect(lock.assertOwnership()).rejects.toMatchObject({ code: "ownership_lost" });
    await rename(path, `${path}.replacement`);
    await rename(`${path}.old`, path);
    await expect(lock.assertOwnership()).rejects.toMatchObject({ code: "ownership_lost" });
    await rename(path, `${path}.old`);
    await rename(`${path}.replacement`, path);
    await lock.release();
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(await readFile(`${path}.old`, "utf8")).toBe("");
  });
});

describe("T2 IPC 同步的真实双进程锁验收", () => {
  it("同会话一写一拒，不同会话独立，关闭描述符后后继可接管", async () => {
    const first = await childProcess();
    const second = await childProcess();
    const sessionId = id();
    expect(await first.request("acquire", sessionId)).toBe("held");
    await expect(second.request("acquire", sessionId)).rejects.toMatchObject({ code: "session_busy" });
    expect(await second.request("acquire", id())).toBe("held");
    expect(await second.request("probe", sessionId)).toBe("busy");
    await first.request("release", sessionId);
    // 先释放 second 的不同会话句柄，再接管目标，fixture 一次只持有一个写锁。
    await second.request("release", sessionId);
    expect(await second.request("acquire", sessionId)).toBe("held");
    expect((await lstat(join(root, "locks", `${sessionId}.lock`))).isFile()).toBe(true);
  });

  it("shnb 探测兼容另一个共享读者，exnb 写者仍拒绝", async () => {
    const sessionId = id();
    await (await acquire(sessionId)).release();
    const shared = await childProcess();
    expect(await shared.request("shared", sessionId)).toBe("shared");
    const adapter = new SessionLockAdapter({ storageRoot: root });
    expect(await adapter.probe(sessionId)).toBe("available");
    await expect(adapter.acquire(sessionId)).rejects.toMatchObject({ code: "session_busy" });
  });

  it("SIGSTOP 与旧 mtime 不抢占，SIGKILL 的 exit 确认后接管且锁文件 inode 保留", async () => {
    const sessionId = id();
    const holder = await childProcess();
    await holder.request("acquire", sessionId);
    const path = join(root, "locks", `${sessionId}.lock`);
    const before = await lstat(path);
    await utimes(path, new Date(0), new Date(0));
    holder.child.kill("SIGSTOP");
    await waitStopped(holder.child.pid!);
    const contender = await childProcess();
    await expect(contender.request("acquire", sessionId)).rejects.toMatchObject({ code: "session_busy" });
    expect(await contender.request("probe", sessionId)).toBe("busy");
    const exited = once(holder.child, "exit");
    holder.child.kill("SIGKILL");
    await exited;
    expect(await contender.request("acquire", sessionId)).toBe("held");
    const after = await lstat(path);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  });
});
