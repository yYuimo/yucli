import { appendFile, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanSessionFile, scanSessionHandle } from "../src/adapters/session/scanSession.js";
import type { ScanResult, ValidScanResult } from "../src/adapters/session/scanTypes.js";
import { PersistenceError, SessionAccessError } from "../src/contracts/session.js";
import { PersistenceError as LockPersistenceError, SessionAccessError as LockAccessError } from "../src/contracts/session-lock.js";

const createdAt = "2026-10-29T12:00:00.000Z";
const filename = "2026-10-29T12-00-00-000Z_session-123.jsonl";
const header = { type: "session_meta", formatVersion: 1, sessionId: "session-123", createdAt, cwd: "/example/project" };
const profile = { provider: "opencode-go", model: "deepseek-v4-flash" };
const failure = { outcome: "failed", error: { category: "model", code: "network", message: "请求失败。" } };
const cancellation = { outcome: "cancelled", error: { category: "cancellation", code: "user_interrupt", message: "已取消。" } };
const timeout = { outcome: "timeout", error: { category: "timeout", code: "request_timeout", message: "请求超时。" } };

interface Row {
  type: string;
  payload: Record<string, unknown>;
  turnId?: string;
  seq?: number | undefined;
  timestamp?: string;
  [key: string]: unknown;
}

function user(content = "读取中文文件😀", turnId = "turn-a"): Row {
  return { type: "message", turnId, runtimeProfile: profile, payload: { role: "user", content } };
}

function assistant(content = "完整回答。", calls?: unknown[]): Row {
  return { type: "message", payload: { role: "assistant", content, ...(calls ? { toolCalls: calls } : {}) } };
}

function call(id = "call-a", name = "read_file", argumentsJson = '{"path":"a.md"}') {
  return { id, name, argumentsJson };
}

function tool(type: string, id = "call-a", callMessageSeq = 2, extra: Record<string, unknown> = {}): Row {
  return { type, payload: { callMessageSeq, toolCallId: id, name: "read_file", ...extra } };
}

function end(payload: Record<string, unknown> = { outcome: "success" }): Row {
  return { type: "turn_end", payload };
}

function textTurn(): Row[] {
  return [user(), assistant(), end()];
}

function batchTurn(): Row[] {
  return [
    user(), assistant("", [call(), call("call-b")]),
    tool("tool_start"), tool("tool_result", "call-a", 2, { ok: true, content: "" }),
    tool("tool_start", "call-b"), tool("tool_result", "call-b", 2, { ok: false, content: "无法读取。" }),
    assistant(), end(),
  ];
}

function encoded(rows: Row[], first: unknown = header, lf = true): Buffer {
  const lines = [JSON.stringify(first), ...rows.map((row, index) => JSON.stringify({ seq: index + 1, timestamp: createdAt, turnId: "turn-a", ...row }))];
  return Buffer.from(lines.join("\n") + (lf ? "\n" : ""));
}

function valid(result: ScanResult): ValidScanResult {
  expect(result.status, result.status === "rejected" ? JSON.stringify(result.diagnostic) : "").toBe("valid");
  if (result.status !== "valid") throw new Error("expected valid scan");
  return result;
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "yucli-t3-scan-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function scanBytes(bytes: Buffer, chunkSizeBytes = 7): Promise<ScanResult> {
  const path = join(root, filename);
  await writeFile(path, bytes, { mode: 0o600 });
  const result = await scanSessionFile(path, { chunkSizeBytes });
  expect(await readFile(path)).toEqual(bytes);
  expect(await readdir(root)).toEqual([filename]);
  return result;
}

async function rejectRows(rows: Row[], recordIndex: number, code?: string): Promise<void> {
  const bytes = encoded(rows);
  const result = await scanBytes(bytes);
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("expected rejected scan");
  const lines = bytes.toString().split("\n");
  const byteOffset = Buffer.byteLength(lines.slice(0, recordIndex + 1).join("\n") + "\n");
  expect(result).not.toHaveProperty("recentSuccessfulTurns");
  expect(result).not.toHaveProperty("validEndBytes");
  expect(result.diagnostic).toMatchObject({ line: recordIndex + 2, byteOffset, lineEndBytes: byteOffset + Buffer.byteLength(lines[recordIndex + 1]!) + 1 });
  if (code) expect(result.diagnostic.code).toBe(code);
}

describe("B01/B03 JSONL schema 和完整文件", () => {
  it("header-only、成功文本、工具 ok:false 与空结果均合法", async () => {
    const empty = valid(await scanBytes(encoded([])));
    expect(empty).toMatchObject({ tailKind: "none", logState: "empty", lastSeq: 0, statistics: { turnCount: 0, lastTurnOutcome: null } });

    const text = valid(await scanBytes(encoded(textTurn())));
    expect(text).toMatchObject({ logState: "complete", lastSeq: 3, statistics: { turnCount: 1, lastTurnOutcome: "success" } });
    expect(text.recentSuccessfulTurns[0]?.runtimeProfile).toEqual(profile);

    const tools = valid(await scanBytes(encoded(batchTurn())));
    expect(tools.turns[0]?.calls).toMatchObject([{ state: "result", ok: true }, { state: "result", ok: false }]);
    expect(tools.recentSuccessfulTurns[0]?.items.map((item) => item.type)).toEqual(["user", "assistant", "tool_result", "tool_result", "assistant"]);
    expect(JSON.stringify(tools.recentSuccessfulTurns)).not.toContain("callMessageSeq");
    expect(tools.recentSuccessfulTurns[0]?.items[2]).toEqual({ type: "tool_result", result: { toolCallId: "call-a", name: "read_file", ok: true, content: "" } });
  });

  it.each([
    ["未知版本", { ...header, formatVersion: 2 }, "unsupported"],
    ["非整数版本", { ...header, formatVersion: "1" }, "corrupt"],
    ["额外字段", { ...header, secret: "not-allowed" }, "corrupt"],
    ["缺字段", { ...header, cwd: undefined }, "corrupt"],
    ["相对目录", { ...header, cwd: "relative" }, "corrupt"],
    ["未规范路径", { ...header, cwd: "/example/../project" }, "corrupt"],
    ["非法日期", { ...header, createdAt: "2026-02-30T12:00:00.000Z" }, "corrupt"],
    ["偏移时区", { ...header, createdAt: "2026-10-29T12:00:00+00:00" }, "corrupt"],
    ["身份不一致", { ...header, sessionId: "other" }, "corrupt"],
    ["时间不一致", { ...header, createdAt: "2026-10-29T12:00:01.000Z" }, "corrupt"],
    ["不安全身份", { ...header, sessionId: "../x" }, "corrupt"],
    ["首行不是 header", { type: "message", payload: {} }, "corrupt"],
  ])("拒绝 header：%s", async (_label, value, state) => {
    const result = await scanBytes(encoded(textTurn(), value));
    expect(result).toMatchObject({ status: "rejected", logState: state, diagnostic: { line: 1, byteOffset: 0 } });
  });

  const schemaCases: [string, (rows: Row[]) => void, number][] = [
    ["seq 缺失", (r) => { r[0]!.seq = undefined; }, 0],
    ["seq 非整数", (r) => { r[0]!.seq = 1.5; }, 0],
    ["seq 超安全整数", (r) => { r[0]!.seq = Number.MAX_SAFE_INTEGER + 1; }, 0],
    ["时间非法", (r) => { r[0]!.timestamp = "bad"; }, 0],
    ["turnId 空白", (r) => { r[0]!.turnId = " "; }, 0],
    ["额外公共字段", (r) => { r[0]!.eventId = "forbidden"; }, 0],
    ["重复 header", (r) => { r[1] = header as unknown as Row; }, 1],
    ["未知事件", (r) => { r[1]!.type = "future"; }, 1],
    ["system 消息", (r) => { r[0]!.payload.role = "system"; }, 0],
    ["tool 消息", (r) => { r[0]!.payload.role = "tool"; }, 0],
    ["空白 user", (r) => { r[0]!.payload.content = " \n"; }, 0],
    ["摘要缺 model", (r) => { r[0]!.runtimeProfile = { provider: "x" }; }, 0],
    ["摘要额外字段", (r) => { r[0]!.runtimeProfile = { ...profile, endpoint: "forbidden" }; }, 0],
    ["摘要空值", (r) => { r[0]!.runtimeProfile = { provider: " ", model: "x" }; }, 0],
    ["摘要 null", (r) => { r[0]!.runtimeProfile = null; }, 0],
    ["assistant 外层摘要", (r) => { r[1]!.runtimeProfile = profile; }, 1],
    ["摘要放入 payload", (r) => { r[0]!.payload.runtimeProfile = profile; }, 0],
    ["assistant 空白最终回答", (r) => { r[6]!.payload.content = " \n\t"; }, 6],
    ["assistant 缺最终回答", (r) => { delete r[6]!.payload.content; }, 6],
    ["assistant content null", (r) => { r[6]!.payload.content = null; }, 6],
    ["assistant 多余字段", (r) => { r[1]!.payload.assistantId = "a1"; }, 1],
    ["工具批次非数组", (r) => { r[1]!.payload.toolCalls = {}; }, 1],
    ["工具批次超过4", (r) => { r[1]!.payload.toolCalls = Array.from({ length: 5 }, (_, i) => call(String(i))); }, 1],
    ["工具重复 ID", (r) => { r[1]!.payload.toolCalls = [call(), call()]; }, 1],
    ["工具空 ID", (r) => { r[1]!.payload.toolCalls = [call(" ")]; }, 1],
    ["工具空名称", (r) => { r[1]!.payload.toolCalls = [call("a", " ")]; }, 1],
    ["工具缺参数", (r) => { r[1]!.payload.toolCalls = [{ id: "a", name: "read_file" }]; }, 1],
    ["工具坏参数 JSON", (r) => { r[1]!.payload.toolCalls = [call("a", "read_file", "{")]; }, 1],
    ["工具参数额外字段", (r) => { r[1]!.payload.toolCalls = [call("a", "read_file", '{"path":"x","encoding":"utf8"}')]; }, 1],
    ["工具参数类型", (r) => { r[1]!.payload.toolCalls = [call("a", "read_file", '{"path":1}')]; }, 1],
    ["工具参数数组", (r) => { r[1]!.payload.toolCalls = [call("a", "read_file", "[]")]; }, 1],
    ["工具额外字段", (r) => { r[1]!.payload.toolCalls = [{ ...call(), extra: true }]; }, 1],
    ["工具结果 ok 类型", (r) => { r[3]!.payload.ok = "true"; }, 3],
    ["工具结果 content 类型", (r) => { r[3]!.payload.content = null; }, 3],
    ["工具引用序号非法", (r) => { r[2]!.payload.callMessageSeq = 0; }, 2],
    ["success 带 error", (r) => { r[7]!.payload.error = failure.error; }, 7],
    ["failed 无 error", (r) => { r[7]!.payload = { outcome: "failed" }; }, 7],
    ["cancelled 无 error", (r) => { r[7]!.payload = { outcome: "cancelled" }; }, 7],
    ["timeout 无 error", (r) => { r[7]!.payload = { outcome: "timeout" }; }, 7],
    ["非法 outcome", (r) => { r[7]!.payload = { outcome: "interrupted" }; }, 7],
    ["错误分类不配对", (r) => { r[7]!.payload = { outcome: "failed", error: cancellation.error }; }, 7],
    ["错误分类不能为数组", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, category: ["model"] } }; }, 7],
    ["错误 code 不能为对象", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, code: { toString: "network" } } }; }, 7],
    ["错误 code 不配对", (r) => { r[7]!.payload = { outcome: "failed", error: { ...failure.error, code: "arbitrary" } }; }, 7],
    ["错误带 stack", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, stack: "forbidden" } }; }, 7],
    ["错误 HTTP 范围", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, httpStatus: 600 } }; }, 7],
    ["错误 HTTP 下界", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, httpStatus: 99 } }; }, 7],
    ["错误 HTTP 非整数", (r) => { r[7]!.payload = { ...failure, error: { ...failure.error, httpStatus: 200.5 } }; }, 7],
    ["tool_end 不能 success", (r) => { r[3] = tool("tool_end", "call-a", 2, { outcome: "success", error: failure.error }); }, 3],
  ];
  it.each(schemaCases)("拒绝非法 schema：%s", async (_label, change, index) => {
    const rows = batchTurn();
    change(rows);
    await rejectRows(rows, index, "schema");
  });

  it("旧 user 可以缺摘要，时间允许倒退，空工具数组按最终文本判断", async () => {
    const rows = textTurn();
    delete rows[0]!.runtimeProfile;
    rows[1]!.timestamp = "2020-01-01T00:00:00Z";
    rows[1]!.payload.toolCalls = [];
    const result = valid(await scanBytes(encoded(rows)));
    expect(result.recentSuccessfulTurns[0]).not.toHaveProperty("runtimeProfile");
    expect(result.statistics).not.toHaveProperty("lastUserProfile");
    expect(result.recentSuccessfulTurns[0]?.items[0]).toEqual({ type: "user", message: rows[0]!.payload });
  });

  it.each(["2026-10-29T12:00:00.1Z", "2026-10-29T12:00:00.123456Z"])("时间小数精度不受JS毫秒限制：%s", async (timestamp) => {
    const rows = textTurn();
    rows[2]!.timestamp = timestamp;
    expect(valid(await scanBytes(encoded(rows))).statistics.lastActivityAt).toBe(timestamp);
  });

  it.each([
    ["model", "network"], ["model", "http"], ["model", "invalid_response"],
    ["protocol", "protocol_error"], ["limit", "loop_limit"],
    ["tool", "tool_execution_failed"], ["internal", "internal_error"],
  ])("合法失败配对 %s/%s", async (category, code) => {
    const result = valid(await scanBytes(encoded([user(), end({ outcome: "failed", error: { category, code, message: "安全摘要。", httpStatus: 100 } })])));
    expect(result.logState).toBe("complete");
    expect(result.recentSuccessfulTurns).toEqual([]);
  });

  it.each([failure, cancellation, timeout, { ...cancellation, error: { ...cancellation.error, code: "cancelled_before_dispatch" } }])("允许合法非成功终止 %j", async (termination) => {
    const result = valid(await scanBytes(encoded([user(), end(termination)])));
    expect(result).toMatchObject({ logState: "complete", statistics: { lastTurnOutcome: termination.outcome, interruptedTurnCount: 0 } });
  });
});

describe("B01/B02/B03 seq、引用和生命周期", () => {
  it("不同 assistant 批次可重用 ID；未知工具名也可合法记录", async () => {
    const rows = [
      user(), assistant("", [call()]), tool("tool_start"), tool("tool_result", "call-a", 2, { ok: true, content: "a" }),
      assistant("", [call("call-a", "unknown")]),
      tool("tool_start", "call-a", 5, { name: "unknown" }),
      tool("tool_result", "call-a", 5, { name: "unknown", ok: false, content: "b" }), assistant(), end(),
    ];
    const result = valid(await scanBytes(encoded(rows)));
    expect(result.turns[0]?.calls).toMatchObject([{ callMessageSeq: 2, toolCallId: "call-a", ok: true }, { callMessageSeq: 5, toolCallId: "call-a", ok: false }]);
  });

  const semanticCases: [string, (rows: Row[]) => void, number, string][] = [
    ["seq 起点非1", (r) => { r[0]!.seq = 2; }, 0, "sequence"],
    ["seq 重复", (r) => { r[1]!.seq = 1; }, 1, "sequence"],
    ["seq 缺口", (r) => { r[2]!.seq = 4; }, 2, "sequence"],
    ["seq 倒退", (r) => { r[2]!.seq = 1; }, 2, "sequence"],
    ["无 user 起点", (r) => { r.shift(); }, 0, "lifecycle"],
    ["同 turn 多 user", (r) => { r.splice(1, 0, user()); }, 1, "lifecycle"],
    ["跨 turn 引用", (r) => { r[2]!.turnId = "other"; }, 2, "lifecycle"],
    ["引用未来 assistant", (r) => { r[2]!.payload.callMessageSeq = 7; }, 2, "reference"],
    ["引用 user", (r) => { r[2]!.payload.callMessageSeq = 1; }, 2, "reference"],
    ["名称不匹配", (r) => { r[2]!.payload.name = "other"; }, 2, "reference"],
    ["调用 ID 不匹配", (r) => { r[2]!.payload.toolCallId = "other"; }, 2, "reference"],
    ["result 无 start", (r) => { r.splice(2, 1); }, 2, "lifecycle"],
    ["end 无 start", (r) => { r[2] = tool("tool_end", "call-a", 2, failure); }, 2, "lifecycle"],
    ["start 重复", (r) => { r.splice(3, 0, tool("tool_start")); }, 3, "lifecycle"],
    ["result 重复", (r) => { r.splice(4, 0, tool("tool_result", "call-a", 2, { ok: true, content: "" })); }, 4, "lifecycle"],
    ["result 后又 end", (r) => { r.splice(4, 0, tool("tool_end", "call-a", 2, failure)); }, 4, "lifecycle"],
    ["工具越序开始", (r) => { r[2]!.payload.toolCallId = "call-b"; }, 2, "lifecycle"],
    ["前项无 result 就开始后项", (r) => { r[3] = tool("tool_start", "call-b"); }, 3, "lifecycle"],
    ["tool_end 后开始后项", (r) => { r[3] = tool("tool_end", "call-a", 2, failure); }, 4, "lifecycle"],
    ["tool_end 后 result", (r) => { r[3] = tool("tool_end", "call-a", 2, failure); r[4] = tool("tool_result", "call-a", 2, { ok: true, content: "" }); }, 4, "lifecycle"],
    ["tool_end 重复", (r) => { r[3] = tool("tool_end", "call-a", 2, failure); r[4] = tool("tool_end", "call-a", 2, failure); }, 4, "lifecycle"],
    ["工具未完就 assistant", (r) => { r[3] = assistant(); }, 3, "lifecycle"],
    ["最终回答后又 assistant", (r) => { r.splice(7, 0, assistant()); }, 7, "lifecycle"],
    ["最终回答后又工具", (r) => { r.splice(7, 0, tool("tool_start")); }, 7, "lifecycle"],
    ["success 缺最终回答", (r) => { r.splice(6, 1); }, 6, "lifecycle"],
    ["success 缺工具结果", (r) => { r[3] = end(); }, 3, "lifecycle"],
    ["success 含 tool_end", (r) => { r[3] = tool("tool_end", "call-a", 2, failure); r[4] = end(); }, 4, "lifecycle"],
    ["turn_end 后仍有记录", (r) => { r.push(assistant()); }, 8, "lifecycle"],
    ["turn_end 重复", (r) => { r.push(end()); }, 8, "lifecycle"],
  ];
  it.each(semanticCases)("拒绝语义损坏：%s", async (_label, change, index, code) => {
    const rows = batchTurn();
    change(rows);
    await rejectRows(rows, index, code);
  });

  it("切换新 turn 后不能复用旧 turnId，也不能交错补旧 end", async () => {
    for (const old of [user(), end(failure)]) {
      const rows = [user(), user("新问题", "turn-b"), old];
      await rejectRows(rows, 2, "lifecycle");
    }
  });

  it("同 ID 的旧批次、旧 turn 引用均不能串配", async () => {
    const oldBatch = [
      user(), assistant("", [call()]), tool("tool_start"), tool("tool_result", "call-a", 2, { ok: true, content: "" }),
      assistant("", [call()]), tool("tool_start", "call-a", 2),
    ];
    await rejectRows(oldBatch, 5, "lifecycle");
    const oldTurn = [
      ...oldBatch.slice(0, 4), assistant(), end(), user("新问题", "b"),
      { ...assistant("", [call()]), turnId: "b" }, { ...tool("tool_start", "call-a", 2), turnId: "b" },
    ];
    await rejectRows(oldTurn, 8, "reference");
  });

  it("错误引用诊断含 seq/turn/调用定位，不含正文", async () => {
    const rows = batchTurn();
    rows[2]!.payload.callMessageSeq = 999;
    const result = await scanBytes(encoded(rows));
    expect(result).toMatchObject({ status: "rejected", diagnostic: { line: 4, seq: 3, turnId: "turn-a", callMessageSeq: 999, toolCallId: "call-a" } });
    expect(JSON.stringify(result, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).not.toContain("读取中文文件");
  });

  it("先前成功 turn 不允许掩盖后面坏 turn", async () => {
    const rows = [...textTurn(), ...textTurn().map((row) => ({ ...row, turnId: "turn-b" }))];
    rows[4]!.payload.content = " ";
    await rejectRows(rows, 4, "schema");
  });
});

describe("B04 诊断和成功窗口", () => {
  it("user-only 是 interrupted，不伪造结束或成功历史", async () => {
    const result = valid(await scanBytes(encoded([user()])));
    expect(result).toMatchObject({ logState: "interrupted", lastSeq: 1, statistics: { turnCount: 1, interruptedTurnCount: 1, lastTurnOutcome: "interrupted" }, recentSuccessfulTurns: [] });
    expect(result.turns).toEqual([{ turnId: "turn-a", userSeq: 1, outcome: "interrupted", calls: [] }]);
  });

  it("最终回答后缺 turn_end 仍为 interrupted，不提交成功历史", async () => {
    const result = valid(await scanBytes(encoded(textTurn().slice(0, 2))));
    expect(result).toMatchObject({ logState: "interrupted", recentSuccessfulTurns: [], statistics: { lastTurnOutcome: "interrupted" } });
  });

  it.each([2, 3, 4, 5])("批次在记录 %i 截止：保留已知结果，其余 unknown", async (count) => {
    const result = valid(await scanBytes(encoded(batchTurn().slice(0, count))));
    const expected = count < 4 ? [{ state: "unknown" }, { state: "unknown" }] : [{ state: "result", ok: true }, { state: "unknown" }];
    expect(result.turns[0]?.calls).toMatchObject(expected);
    expect(result.recentSuccessfulTurns).toEqual([]);
  });

  it.each([2, 3, 4, 5])("有终止时记录 %i 之后：未 start 才是 not_started", async (count) => {
    const result = valid(await scanBytes(encoded([...batchTurn().slice(0, count), end(cancellation)])));
    const first = count === 2 ? "not_started" : count === 3 ? "unknown" : "result";
    const second = count === 5 ? "unknown" : "not_started";
    expect(result.turns[0]?.calls.map((item) => item.state)).toEqual([first, second]);
    expect(result.logState).toBe("complete");
  });

  it("旧中断含已知工具异常，新成功不覆盖 interruption", async () => {
    const rows = [...batchTurn().slice(0, 3), tool("tool_end", "call-a", 2, failure), ...textTurn().map((row) => ({ ...row, turnId: "new-turn" }))];
    const result = valid(await scanBytes(encoded(rows)));
    expect(result).toMatchObject({ logState: "interrupted", statistics: { interruptedTurnCount: 1, lastTurnOutcome: "success" } });
    expect(result.turns[0]?.calls).toMatchObject([{ state: "ended", end: failure }, { state: "unknown" }]);
    expect(result.recentSuccessfulTurns.map((turn) => turn.turnId)).toEqual(["new-turn"]);
  });

  it("只保留最近20组完整 success，失败不占成功窗口", async () => {
    const rows: Row[] = [];
    for (let index = 0; index < 25; index++) {
      rows.push(...textTurn().map((row) => ({ ...row, turnId: `success-${index}` })));
      rows.push(user("失败问题", `failed-${index}`), { ...end(failure), turnId: `failed-${index}` });
    }
    const result = valid(await scanBytes(encoded(rows), 1024));
    expect(result.recentSuccessfulTurns).toHaveLength(20);
    expect(result.recentSuccessfulTurns[0]?.turnId).toBe("success-5");
    expect(result.recentSuccessfulTurns.at(-1)?.turnId).toBe("success-24");
    expect(result.statistics).toMatchObject({ turnCount: 50, lastTurnOutcome: "failed" });
  });

  it("预览按 Unicode 码点裁剪，正文不改写，最近 user 无摘要不沿用旧摘要", async () => {
    const prompt = "\u001b\n" + "😀".repeat(100);
    const next = user("下一轮", "b");
    delete next.runtimeProfile;
    const result = valid(await scanBytes(encoded([user(prompt), assistant(), end(), next])));
    expect([...result.statistics.preview]).toHaveLength(80);
    expect(result.statistics.preview).toBe("😀".repeat(80));
    expect(result.recentSuccessfulTurns[0]?.items[0]).toEqual({ type: "user", message: { role: "user", content: prompt } });
    expect(result.statistics).not.toHaveProperty("lastUserProfile");
  });
});

describe("B05/B06 字节边界、严格尾部分类和原件不变", () => {
  it.each([1, 2, 3, 7, 64 * 1024])("每次 read %i 字节不破坏 UTF-8/物理行", async (chunkSize) => {
    const bytes = encoded(textTurn());
    const result = valid(await scanBytes(bytes, chunkSize));
    expect(result).toMatchObject({ observedSizeBytes: bytes.length, validEndBytes: bytes.length, lastLfEndBytes: bytes.length, lastSeq: 3, tailKind: "none", changing: false });
    expect(result.dev).toBeTypeOf("bigint");
    expect(result.ino).toBeTypeOf("bigint");
    expect(bytes.length).toBeGreaterThan(bytes.toString().length);
  });

  it("合法最后记录缺 LF，仍计入 seq/S，不创建备份或补 LF", async () => {
    const bytes = encoded(textTurn(), header, false);
    const result = valid(await scanBytes(bytes));
    expect(result).toMatchObject({ tailKind: "missing_lf", logState: "missing_lf", lastSeq: 3, validEndBytes: bytes.length });
    expect(result.lastLfEndBytes).toBe(bytes.lastIndexOf(0x0a) + 1);
    expect(result.recentSuccessfulTurns).toHaveLength(1);
  });

  it.each(['{"seq":4,', '{"seq":4,"payload":{"content":"', ' \t']) ("可完成尾行只保留前缀P：%s", async (fragment) => {
    const prefix = encoded(textTurn());
    const bytes = Buffer.concat([prefix, Buffer.from(fragment)]);
    const result = valid(await scanBytes(bytes));
    expect(result).toMatchObject({ tailKind: "incomplete", logState: "torn_tail", observedSizeBytes: bytes.length, validEndBytes: prefix.length, lastLfEndBytes: prefix.length, lastSeq: 3 });
  });

  it("半个汉字仅在字符串内允许；带 LF 或在字符串外都拒绝", async () => {
    const prefix = encoded(textTurn());
    const bytes = Buffer.concat([prefix, Buffer.from('{"seq":4,"x":"'), Buffer.from([0xe4, 0xb8])]);
    expect(valid(await scanBytes(bytes)).tailKind).toBe("incomplete");
    for (const tail of [Buffer.concat([Buffer.from('{"seq":4,"x":'), Buffer.from([0xe4, 0xb8])]), Buffer.concat([bytes.subarray(prefix.length), Buffer.from("\n")])]) {
      expect(await scanBytes(Buffer.concat([prefix, tail]))).toMatchObject({ status: "rejected", logState: "corrupt", diagnostic: { line: 5, byteOffset: prefix.length } });
    }
  });

  it.each(['{"seq":4,}', '{"seq":4}', '[]', 'null', '{"x":"\\q', '{"x":01}', '{}{}']) ("无 LF 也拒绝确定非法或完整但业务非法的尾行：%s", async (tail) => {
    const prefix = encoded(textTurn());
    const result = await scanBytes(Buffer.concat([prefix, Buffer.from(tail)]));
    expect(result).toMatchObject({ status: "rejected", logState: "corrupt", diagnostic: { line: 5, byteOffset: prefix.length } });
  });

  it("最后完整 JSON 的 seq/引用/生命周期错误不能降为残片", async () => {
    const rows: Row[][] = [
      [user(), { ...assistant(), seq: 99 }],
      [user(), assistant("", [call()]), tool("tool_start", "call-a", 99)],
      [user(), end()],
    ];
    for (const records of rows) {
      expect(await scanBytes(encoded(records, header, false))).toMatchObject({ status: "rejected", tailKind: "corrupt" });
    }
  });

  it.each([Buffer.from("\n"), Buffer.from('{"seq":4,\n'), Buffer.from([0xff, 0x0a]), Buffer.from("not-json\n")])("完整坏行不能跳过：%j", async (bad) => {
    const prefix = encoded(textTurn());
    expect(await scanBytes(Buffer.concat([prefix, bad, encoded(textTurn())]))).toMatchObject({ status: "rejected", diagnostic: { line: 5, byteOffset: prefix.length } });
  });

  it.each([Buffer.alloc(0), Buffer.from('{"type":"session_meta",'), Buffer.from([0xe4, 0xb8]), Buffer.from("\n")])("缺失/不完整 header 永不作为可恢复尾部：%j", async (bytes) => {
    expect(await scanBytes(bytes)).toMatchObject({ status: "rejected", logState: "corrupt", diagnostic: { line: 1, byteOffset: 0 } });
  });

  it("完整 header 缺LF是 missing_lf，优先级高于 empty", async () => {
    expect(valid(await scanBytes(encoded([], header, false)))).toMatchObject({ tailKind: "missing_lf", logState: "missing_lf", lastSeq: 0 });
  });

  it("初始S之后的并发追加不参与解释，changing=true", async () => {
    const path = join(root, filename);
    const bytes = encoded(textTurn());
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      const originalRead = handle.read.bind(handle);
      const spy = vi.spyOn(handle, "read").mockImplementationOnce(async (...args: Parameters<typeof handle.read>) => {
        await appendFile(path, "definitely-invalid-new-data\n");
        return originalRead(...args);
      });
      const result = valid(await scanSessionHandle(handle, filename, { chunkSizeBytes: 3 }));
      expect(result).toMatchObject({ observedSizeBytes: bytes.length, validEndBytes: bytes.length, lastSeq: 3, changing: true });
      expect(spy).toHaveBeenCalled();
      expect((await handle.stat()).isFile()).toBe(true);
    } finally {
      await handle.close();
    }
    expect(await readFile(path)).toEqual(Buffer.concat([bytes, Buffer.from("definitely-invalid-new-data\n")]));
  });

  it("借用句柄在初始范围内读到EOF时拒绝，不返回局部历史", async () => {
    const path = join(root, filename);
    await writeFile(path, encoded(textTurn()));
    const handle = await open(path, "r");
    try {
      vi.spyOn(handle, "read").mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
      expect(await scanSessionHandle(handle, filename)).toMatchObject({ status: "rejected", diagnostic: { code: "source_changed" } });
    } finally {
      await handle.close();
    }
  });

  it("借用句柄读取失败脱敏；调用方仍负责关闭描述符", async () => {
    const path = join(root, filename);
    await writeFile(path, encoded(textTurn()));
    const handle = await open(path, "r");
    try {
      vi.spyOn(handle, "read").mockRejectedValueOnce(new Error("RAW SECRET AND PATH"));
      const error: unknown = await scanSessionHandle(handle, filename).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SessionAccessError);
      expect(error).toMatchObject({ code: "permission_denied", operation: "scan" });
      expect(String(error)).not.toContain("RAW SECRET");
      expect((await handle.stat()).isFile()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("缺路径不创建目录，目录与符号链接不能作为普通日志", async () => {
    await expect(scanSessionFile(join(root, "missing", filename))).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(root)).toEqual([]);
    await expect(scanSessionFile(root)).rejects.toMatchObject({ code: "invalid_identity" });
    const real = join(root, "real.jsonl");
    await writeFile(real, encoded(textTurn()));
    const link = join(root, filename);
    await symlink(real, link);
    await expect(scanSessionFile(link)).rejects.toBeInstanceOf(SessionAccessError);
  });

  it("T2/T3 异常共享相同运行时身份", () => {
    expect(LockAccessError).toBe(SessionAccessError);
    expect(LockPersistenceError).toBe(PersistenceError);
    expect(new LockAccessError("session_busy", "test", "占用。")).toBeInstanceOf(SessionAccessError);
    expect(new PersistenceError("contract_violation", "test", "拒绝。")).toBeInstanceOf(LockPersistenceError);
  });
});
