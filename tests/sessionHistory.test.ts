import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { toolResultToMessage } from "../src/core/toolMessage.js";
import { projectSessionHistory } from "../src/core/sessionHistory.js";
import type { RecoveredTurn, SessionSnapshot, TurnFact } from "../src/contracts/session.js";
import { SessionFileAdapter } from "../src/adapters/session/SessionFileAdapter.js";

const profile = { provider: "opencode-go", model: "test-model" };
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

function turn(index = 0): RecoveredTurn {
  return { turnId: `turn-${index}`, runtimeProfile: profile, items: [
    { type: "user", message: { role: "user", content: `问题 ${index}` } },
    { type: "assistant", message: { role: "assistant", content: "先读", toolCalls: [{ id: "same", name: "read_file", argumentsJson: '{"path":"x"}' }] } },
    { type: "tool_result", result: { toolCallId: "same", name: "read_file", ok: false, content: "" } },
    { type: "assistant", message: { role: "assistant", content: `回答 ${index}` } },
  ] };
}

describe("T6 纯工具消息和恢复历史投影", () => {
  it.each([true, false])("ToolResult ok=%s 保留结果原文，投影只含模型业务字段", (ok) => {
    const input = { toolCallId: "same", name: "unknown", ok, content: "中文😀\n\uFEFF原文", callMessageSeq: 9, seq: 12, runtimeProfile: profile };
    const before = structuredClone(input);
    const result = toolResultToMessage(input);
    expect(result).toEqual({ role: "tool", toolCallId: "same", name: "unknown", content: input.content });
    expect(input).toEqual(before);
    result.content = "changed";
    expect(input.content).toBe(before.content);
  });

  it("空历史、空内容和缺 content 的工具 assistant 均纯投影，不补摘要/结束/结果", () => {
    expect(projectSessionHistory([])).toEqual([]);
    const input = turn();
    const assistant = input.items[1]!;
    if (assistant.type === "assistant") delete assistant.message.content;
    const groups = projectSessionHistory([input]);
    expect(groups[0]!.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(groups[0]![1]).not.toHaveProperty("content");
    expect(groups[0]![2]).toEqual(toolResultToMessage({ toolCallId: "same", name: "read_file", ok: false, content: "" }));
    expect(JSON.stringify(groups)).not.toMatch(/ok|runtimeProfile|callMessageSeq|assistantId|turnId|"seq"/u);
  });

  it.each([1, 20, 21, 25])("%i 个 success 先整组取最近20个，组内调用/结果顺序不变", (count) => {
    const input = Array.from({ length: count }, (_, i) => turn(i));
    const before = structuredClone(input);
    const result = projectSessionHistory(input);
    expect(result).toHaveLength(Math.min(20, count));
    expect(result[0]![0]).toEqual({ role: "user", content: `问题 ${Math.max(0, count - 20)}` });
    expect(result.at(-1)!.at(-1)).toEqual({ role: "assistant", content: `回答 ${count - 1}` });
    expect(result.every((group) => group.length === 4)).toBe(true);
    expect(input).toEqual(before);
  });

  it("显式复制 user/assistant/工具调用，附加存储字段不泄漏且嵌套对象不共享", () => {
    const input = turn();
    const user = input.items[0]!;
    const assistant = input.items[1]!;
    if (user.type !== "user" || assistant.type !== "assistant") throw new Error("fixture");
    Object.assign(user.message, { runtimeProfile: profile, seq: 1 });
    Object.assign(assistant.message, { assistantId: "a1", callMessageSeq: 2 });
    Object.assign(assistant.message.toolCalls![0]!, { seq: 2 });
    const groups = projectSessionHistory([input]);
    expect(JSON.stringify(groups)).not.toMatch(/runtimeProfile|callMessageSeq|assistantId|"seq"/u);
    const output = groups[0]![1]!;
    if (output.role === "assistant") output.toolCalls![0]!.name = "changed";
    expect(assistant.message.toolCalls![0]!.name).toBe("read_file");
  });

  it("真实 T5 快照只交付 success；failed/cancelled/timeout/interrupted 不进入投影且不会自动执行", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "yucli-t6-history-")));
    directories.push(directory);
    const adapter = new SessionFileAdapter({ storageRoot: join(directory, ".yucli") });
    try {
      const opened = await adapter.create(directory);
      const sessionId = opened.snapshot.meta.sessionId;
      for (let index = 0; index < 24; index++) {
        const turnId = randomUUID();
        const facts: TurnFact[] = [
          { type: "user", turnId, runtimeProfile: profile, message: { role: "user", content: `成功问题 ${index}` } },
          { type: "assistant", turnId, assistantId: "a1", message: { role: "assistant", content: `成功回答 ${index}` } },
          { type: "turn_end", turnId, end: { outcome: "success" } },
        ];
        for (const fact of facts) await opened.writer.appendDurable(fact);
        const failed = randomUUID();
        await opened.writer.appendDurable({ type: "user", turnId: failed, runtimeProfile: profile, message: { role: "user", content: "失败问题" } });
        await opened.writer.appendDurable({ type: "turn_end", turnId: failed, end: { outcome: "failed", error: { category: "model", code: "network", message: "请求失败。" } } });
      }
      for (const end of [
        { outcome: "cancelled", error: { category: "cancellation", code: "user_interrupt", message: "已取消。" } },
        { outcome: "timeout", error: { category: "timeout", code: "request_timeout", message: "请求超时。" } },
      ] as const) {
        const turnId = randomUUID();
        await opened.writer.appendDurable({ type: "user", turnId, runtimeProfile: profile, message: { role: "user", content: "不应恢复" } });
        await opened.writer.appendDurable({ type: "turn_end", turnId, end });
      }
      await opened.writer.appendDurable({ type: "user", turnId: randomUUID(), runtimeProfile: profile, message: { role: "user", content: "中断问题" } });
      await opened.writer.close();
      const restored = await adapter.openWrite({ sessionId, cwd: directory });
      const snapshot: SessionSnapshot = restored.snapshot;
      const groups = projectSessionHistory(snapshot.recentSuccessfulTurns);
      expect(groups).toHaveLength(20);
      expect(groups[0]).toEqual([{ role: "user", content: "成功问题 4" }, { role: "assistant", content: "成功回答 4" }]);
      expect(groups.at(-1)).toEqual([{ role: "user", content: "成功问题 23" }, { role: "assistant", content: "成功回答 23" }]);
      expect(snapshot.interruptedTurnCount).toBe(1);
      expect(JSON.stringify(groups)).not.toMatch(/失败问题|不应恢复|中断问题|runtimeProfile|"seq"/u);
    } finally { await adapter.close(); }
  });
});
