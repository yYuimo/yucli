/** T8 的可控单输入源与存储快照；只替换交互/I/O 边界，模型测试仍用真实 HTTP adapter。 */
import { vi } from "vitest";
import type { LineEvent, SessionInput } from "../src/bootstrap/lineInput.js";
import type { SessionList, SessionListEntry, SessionStore, OpenedSession } from "../src/contracts/session.js";
import { deferred } from "./persistenceHelpers.js";

export class QueueInput implements SessionInput {
  tty = true;
  closed = false;
  consumed = 0;
  prompts: string[] = [];
  private lines: LineEvent[] = [];
  private waiter: ReturnType<typeof deferred<LineEvent>> | undefined;
  private interrupts = new Set<() => void>();
  private endings = new Set<() => void>();
  constructor(lines: string[] = []) { for (const text of lines) this.lines.push({ type: "line", text }); }
  async read(prompt: string) {
    this.prompts.push(prompt);
    this.consumed++;
    if (this.lines.length) return this.lines.shift()!;
    if (this.closed) return { type: "eof" } as const;
    this.waiter = deferred<LineEvent>();
    return this.waiter.promise;
  }
  line(text: string) { this.deliver({ type: "line", text }); }
  private deliver(event: LineEvent) {
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(event); }
    else this.lines.push(event);
  }
  interrupt() { for (const callback of this.interrupts) callback(); if (this.waiter) this.deliver({ type: "interrupt" }); }
  end() { this.closed = true; for (const callback of this.endings) callback(); if (this.waiter) this.deliver({ type: "eof" }); }
  onInterrupt(callback: () => void) { this.interrupts.add(callback); return () => { this.interrupts.delete(callback); }; }
  onEnd(callback: () => void) { this.endings.add(callback); return () => { this.endings.delete(callback); }; }
  stop() { this.lines = []; this.end(); }
  dispose() { this.stop(); this.interrupts.clear(); this.endings.clear(); }
}

export function entry(sessionId = "candidate", overrides: Partial<SessionListEntry> = {}): SessionListEntry {
  return { sessionId, createdAt: "2026-10-29T00:00:00.000Z", cwd: "/repo", lastActivityAt: "2026-10-29T00:00:01.000Z", lastSeq: 3,
    turnCount: 1, lastTurnOutcome: "success", preview: "问题", writerState: "available", logState: "complete", observedAt: "2026-10-29T00:00:02.000Z",
    changing: false, resumability: "yes", ...overrides };
}
export function listing(entries: SessionListEntry[] = []): SessionList { return { entries, diagnostics: [], hiddenEmptyCount: 0, unattributedCount: 0 }; }
export function opened(id = "candidate"): OpenedSession {
  return { writer: { appendDurable: vi.fn(async () => ({ confirmedSeq: 1 })), close: vi.fn(async () => {}) },
    snapshot: { meta: { sessionId: id, cwd: "/repo", createdAt: "2026-10-29T00:00:00.000Z" }, recentSuccessfulTurns: [], interruptedTurnCount: 0, repair: "none" } };
}
export function fakeStore(list = listing()): SessionStore {
  return { list: vi.fn(async () => list), create: vi.fn(async () => opened()), openWrite: vi.fn(async () => opened()), close: vi.fn(async () => {}), closeSettled: vi.fn(async () => {}) };
}
