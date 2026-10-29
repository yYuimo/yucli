import { describe, expect, it } from "vitest";
import { SessionSequence } from "../src/adapters/session/sessionSequence.js";
import { validateSessionRecord } from "../src/adapters/session/sessionSchema.js";

const timestamp = "2026-10-29T12:00:00.000Z";

function record(seq: number, type: string, payload: unknown, turnId = "turn-a") {
  return validateSessionRecord({ seq, type, payload, turnId, timestamp });
}

function user(seq = 1, turnId = "turn-a") {
  return record(seq, "message", { role: "user", content: "问题。" }, turnId);
}

describe("SessionSequence 单次使用边界", () => {
  it("finish 后拒绝 accept/重复 finish，已返回的摘要不随重用而改变", () => {
    const sequence = new SessionSequence(timestamp);
    sequence.accept(user());
    sequence.accept(record(2, "message", { role: "assistant", content: "回答。" }));
    sequence.accept(record(3, "turn_end", { outcome: "success" }));
    const summary = sequence.finish();
    const snapshot = structuredClone(summary);

    expect(() => sequence.accept(user(4, "turn-b"))).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(() => sequence.finish()).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(() => sequence.accept(user(4, "turn-c"))).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(sequence.lastSeq).toBe(3);
    expect(summary).toEqual(snapshot);
  });

  it("空校验器 finish 后也不能接收新 turn", () => {
    const sequence = new SessionSequence(timestamp);
    const summary = sequence.finish();
    expect(summary).toMatchObject({ turns: [], recentSuccessfulTurns: [], statistics: { turnCount: 0 } });
    expect(() => sequence.accept(user())).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(() => sequence.finish()).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(sequence.lastSeq).toBe(0);
    expect(summary.turns).toEqual([]);
  });

  it("首条 accept 失败后，不允许用合法 seq 重试或取摘要", () => {
    const sequence = new SessionSequence(timestamp);
    expect(() => sequence.accept(user(2))).toThrowError(expect.objectContaining({ code: "sequence" }));
    expect(() => sequence.accept(user())).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(() => sequence.finish()).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(sequence.lastSeq).toBe(0);
  });

  it.each([
    ["sequence", user(3, "turn-b")],
    ["lifecycle", user(2)],
    ["reference", record(2, "tool_start", { callMessageSeq: 1, toolCallId: "missing", name: "read_file" })],
    ["lifecycle", record(2, "turn_end", { outcome: "success" })],
  ])("已有记录后 %s 失败也会永久拒绝继续/finish", (code, invalid) => {
    const sequence = new SessionSequence(timestamp);
    sequence.accept(user());
    expect(() => sequence.accept(invalid)).toThrowError(expect.objectContaining({ code }));
    expect(() => sequence.accept(record(2, "message", { role: "assistant", content: "不能恢复。" })))
      .toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(() => sequence.finish()).toThrowError(expect.objectContaining({ code: "validator_state" }));
    expect(sequence.lastSeq).toBe(1);
  });
});
