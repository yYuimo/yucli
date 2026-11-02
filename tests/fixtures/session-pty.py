"""T9 的真实 PTY 桥；只运行父测试传入的 Node CLI，输入输出用 JSON 行传递。"""
import codecs
import json
import os
import pty
import select
import signal
import sys


def emit(event):
    """将一个终端/退出事件交付给父测试；不读取配置或自行访问存储。"""
    print(json.dumps(event, ensure_ascii=False), flush=True)


pid, master = pty.fork()
if pid == 0:
    # 分别保留单边 TTY，验证 CLI 要求 stdin/stdout 同时为终端，而非只检查其中一个。
    side = os.environ.get("YUCLI_TEST_PTY_SIDE")
    if side == "input":
        descriptor = os.open(os.devnull, os.O_WRONLY)
        os.dup2(descriptor, 1)
        os.close(descriptor)
    elif side == "output":
        descriptor = os.open(os.devnull, os.O_RDONLY)
        os.dup2(descriptor, 0)
        os.close(descriptor)
    os.execv(sys.argv[1], sys.argv[1:])

emit({"pid": pid})
commands = b""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
reaped = False
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if data:
                emit({"output": decoder.decode(data)})
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            commands += data
            while b"\n" in commands:
                line, commands = commands.split(b"\n", 1)
                command = json.loads(line)
                if "input" in command:
                    os.write(master, command["input"].encode("utf-8"))
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            reaped = True
            # 子进程 close 前可能仍有最后一段输出，先排空真实终端再交付退出码。
            while select.select([master], [], [], 0)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                emit({"output": decoder.decode(data)})
            if os.WIFSIGNALED(status):
                emit({"signal": signal.Signals(os.WTERMSIG(status)).name})
            else:
                emit({"code": os.WEXITSTATUS(status)})
            break
finally:
    if not reaped:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(master)
