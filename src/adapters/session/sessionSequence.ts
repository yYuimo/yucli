/** adapters 层逐记录语义状态机：不读写文件，不执行工具，只依据已通过 schema 的事实推进。 */
import type { RecoveredItem, RecoveredTurn, RuntimeProfile, ToolEnd, TurnEnd } from "../../contracts/session.js";
import type { ToolCall } from "../../contracts/tool.js";
import type { ScanStatistics, ScannedCall, ScannedTurn, ValidScanResult } from "./scanTypes.js";
import { requireSession, type DiskCallRef, type SessionRecord } from "./sessionSchema.js";

/** 单个调用的真实证据；只有 result 才能放行下一项，end 不能当作正常结果。 */
interface CallEvidence {
  /** 以 assistant seq 隔离批次的完整引用，供事件匹配及诊断使用。 */
  ref: DiskCallRef;
  /** 是否见过 tool_start；没有终止时仅凭它不能推断成功或取消。 */
  started: boolean;
  /** 真实终止事实；缺失表示未知或可证明未分派，不能合成结果。 */
  terminal?: { kind: "result"; ok: boolean } | { kind: "end"; end: ToolEnd };
}

/** assistant 原批次；next 是下一个允许 start 的下标，正常 result 后才推进。 */
interface Batch {
  /** 原 assistant 顺序的调用证据；不能按 ID 排序或与其他批次合并。 */
  calls: CallEvidence[];
  /** 下一项 start 的许可位置；值等于长度时本批已有全部正常结果。 */
  next: number;
}

/** 当前 turn 的状态与暂存正文；结束后仅 success 进入最多 20 组的恢复窗口。 */
interface ActiveTurn {
  /** 当前正在扫描的 turn；换 turn 后不能返回这个身份。 */
  turnId: string;
  /** 唯一 user 起点的 seq，用于摘要定位。 */
  userSeq: number;
  /** user 外层摘要；缺失代表未知，不能从前一 turn 继承。 */
  runtimeProfile?: RuntimeProfile;
  /** 暂存本 turn 业务正文，只有 success 才进入恢复窗口。 */
  items: RecoveredItem[];
  /** assistant seq → 批次，保证跨批复用 ID 不会串配。 */
  batches: Map<number, Batch>;
  /** 最近请求工具的批次；它完成前不允许下一条 assistant。 */
  currentBatch?: Batch;
  /** 已出现无调用最终回答；同 turn 后续只接受 turn_end。 */
  finalAssistant: boolean;
  /** 实际结束事实；EOF 仍缺失时推导 interrupted。 */
  end?: TurnEnd;
}

/** 状态机完成后交付扫描器的读模型；没有文件资源或持久化确认含义。 */
export interface SequenceSummary {
  /** 全部合法 turn 的只读统计，不是写入确认或锁探测。 */
  statistics: ScanStatistics;
  /** 最近最多 20 组 success 的业务内容，交给 T6 core 投影。 */
  recentSuccessfulTurns: readonly RecoveredTurn[];
  /** 所有 turn 的无正文证据摘要，失败/中断不会从这里抹除。 */
  turns: readonly ScannedTurn[];
}

/**
 * 在单次扫描内维护 seq、turn 和调用引用，由字节扫描器按物理顺序调用 accept。
 * 失败即拒绝整个扫描，不继续消费后续行；不重排、不补写，也不联系模型/注册表。
 */
export class SessionSequence {
  /** 一旦 accept/finish 失败就永久拒绝后续调用，防止把已部分变更的内存状态当成合法摘要。 */
  private failed = false;
  /** 第一次 finish 成功后置位；包括 header-only，均不能继续追加或再次完成。 */
  private finished = false;
  /** 最后一条全套语义校验成功的 seq，供扫描器生成读边界，不代表 durable 确认。 */
  lastSeq = 0;
  /** 当前 turn 暂存区；换 turn 或 EOF 后释放其失败/中断正文。 */
  private current: ActiveTurn | undefined;
  /** 已出现过的全部 turn 身份；换 turn 后仍保留，以阻止旧身份复用。 */
  private readonly seenTurns = new Set<string>();
  /** 只保留无正文的逐 turn 证据；所有成功/失败/中断都参与列表统计。 */
  private readonly turns: ScannedTurn[] = [];
  /** 最多 20 组完整 success；与诊断数组分开，失败不占窗口。 */
  private readonly successes: RecoveredTurn[] = [];
  /** 最后记录时间与首 user 预览供列表使用，不以文件 mtime 代替日志活动时间。 */
  private lastActivityAt: string;
  private preview = "";
  /** 最近 user 的配置摘要；显式 undefined 表示未知，不能保留上一 user 的值。 */
  private lastUserProfile: RuntimeProfile | undefined;

  /** 用 header 创建时间初始化空文件统计；构造不验证 header，也没有 I/O 或业务执行。 */
  constructor(createdAt: string) {
    this.lastActivityAt = createdAt;
  }

  /**
   * T5 完成持锁扫描/修复后，为后续追加建立全新的校验器，不复活已经 finish 的扫描实例。
   * 只接受换行完整、未观察到变化的合法结果；保存 seq 和所有旧 turnId 以禁止续旧执行。
   * 不复制历史正文或重建旧调用；此实例供 writer 校验新事实，历史快照仍使用原扫描结果。
   */
  static forAppend(scan: ValidScanResult): SessionSequence {
    requireSession(
      scan.status === "valid" && scan.tailKind === "none" && !scan.changing &&
      scan.validEndBytes === scan.observedSizeBytes && Number.isSafeInteger(scan.lastSeq) && scan.lastSeq >= 0,
      "validator_state", "续写需要已验证且换行完整的持锁扫描结果。",
    );
    const next = new SessionSequence(scan.meta.createdAt);
    next.lastSeq = scan.lastSeq;
    for (const turn of scan.turns) next.seenTurns.add(turn.turnId);
    return next;
  }

  /**
   * 接收一条已通过结构校验的完整记录；顺序是 seq → turn 边界 → 事件生命周期。
   * 正常返回后才更新 lastSeq/时间；失败抛安全 SessionFormatIssue，由扫描器附物理位置。
   * 该状态机是单次使用：accept 失败后不能继续，finish 后也不能继续追加。
   */
  accept(record: SessionRecord): void {
    this.requireActive();
    try {
      this.acceptRecord(record);
    } catch (error) {
      // 保留首次具体错误供扫描器定位，但不尝试回滚已经更新的临时 Map/数组。
      // 后续 accept/finish 只能得到状态拒绝，不能靠重试同一 seq “恢复”此校验器。
      this.failed = true;
      throw error;
    }
  }

  /**
   * 为 accept/finish 检查单次使用边界；两个公开方法在任何状态变更前调用。
   * 正常返回代表仍在本次扫描中，完成或失败后抛 validator_state，不改变已返回的读模型。
   */
  private requireActive(): void {
    requireSession(!this.failed && !this.finished, "validator_state", "扫描校验器已失败或结束，不能继续使用。");
  }

  /**
   * 在活跃扫描中执行一条记录的 seq、引用和生命周期检查，由 accept 的失败保护调用。
   * 输入已经通过 schema，成功才推进 lastSeq；失败可能留下部分临时状态，因此必须弃用实例。
   * 只更新内存证据，不回滚、不持久化，也不执行工具。
   */
  private acceptRecord(record: SessionRecord): void {
    requireSession(record.seq === this.lastSeq + 1, "sequence", "seq 必须从 1 开始连续递增。");
    const isUser = record.type === "message" && record.payload.role === "user";

    if (!this.current || this.current.turnId !== record.turnId) {
      requireSession(isUser && !this.seenTurns.has(record.turnId), "lifecycle", "新 turn 必须以新身份的唯一 user 开始，不能返回旧 turn。");
      this.finishCurrent();
      this.seenTurns.add(record.turnId);

      // runtimeProfile 只在 user 联合分支存在；缺失时保留 unknown，不沿用前一 turn 的配置。
      const profile = "runtimeProfile" in record ? record.runtimeProfile : undefined;
      this.current = {
        turnId: record.turnId, userSeq: record.seq, items: [], batches: new Map(), finalAssistant: false,
        ...(profile ? { runtimeProfile: profile } : {}),
      };
      this.lastUserProfile = profile;
    } else {
      requireSession(!isUser, "lifecycle", "同一 turn 不能有第二条 user。");
    }

    const turn = this.current;
    requireSession(!turn.end, "lifecycle", "turn_end 后不能再有同 turn 记录。");
    requireSession(!turn.finalAssistant || record.type === "turn_end", "lifecycle", "最终 assistant 后只允许 turn_end。");

    if (record.type === "message") {
      if (record.payload.role === "user") {
        turn.items.push({ type: "user", message: record.payload });
        if (this.seenTurns.size === 1) {
          // 只对展示摘要去除控制字符和合并空白；业务消息原文保留在 items 中。
          this.preview = [...record.payload.content.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, 80).join("");
        }
      } else {
        requireSession(!turn.currentBatch || this.allResults(turn.currentBatch), "lifecycle", "前一工具批次未全部取得正常结果，不能继续 assistant。");
        const calls = record.payload.toolCalls ?? [];
        turn.items.push({ type: "assistant", message: record.payload });

        if (calls.length) {
          const batch: Batch = { calls: calls.map((call) => this.newCall(record.seq, call)), next: 0 };
          turn.batches.set(record.seq, batch);
          turn.currentBatch = batch;
        } else {
          turn.finalAssistant = true;
        }
      }
    } else if (record.type === "turn_end") {
      if (record.payload.outcome === "success") {
        requireSession(
          turn.finalAssistant && [...turn.batches.values()].every((batch) => this.allResults(batch)),
          "lifecycle", "success 需要全部正常工具结果及最终无调用回答。",
        );
      }
      turn.end = record.payload;
    } else {
      this.acceptTool(record);
    }

    // 只有这条记录的全部语义检查成功，才推进已校验游标；它不是 writer 的 durable 确认。
    this.lastSeq = record.seq;
    this.lastActivityAt = record.timestamp;
  }

  /** 将完整调用转为本批局部证据；由 accept 建批时调用，不把同 ID 的其他批次混在一起。 */
  private newCall(callMessageSeq: number, call: ToolCall): CallEvidence {
    return { ref: { callMessageSeq, toolCallId: call.id, name: call.name }, started: false };
  }

  /** 判断整批是否都正常返回；ok:false 仍是正常 ToolResult，不妨碍后续调用或 turn success。 */
  private allResults(batch: Batch): boolean {
    return batch.calls.every((call) => call.terminal?.kind === "result");
  }

  /**
   * 校验 tool_start/result/end 引用及分派顺序；accept 已保证当前 turn 存在且尚未结束。
   * 只允许当前批次的 next 项；result 推进 next，异常 end/悬空 start 都不能放行后项。
   * 返回后仅更新内存证据，不执行工具；不匹配/重复/越序抛安全 reference/lifecycle 诊断。
   */
  private acceptTool(record: Exclude<SessionRecord, { type: "message" | "turn_end" }>): void {
    const turn = this.current!;
    const ref = record.payload;
    const batch = turn.batches.get(ref.callMessageSeq);
    const call = batch?.calls.find((candidate) => candidate.ref.toolCallId === ref.toolCallId);
    requireSession(
      ref.callMessageSeq < record.seq && batch && call && call.ref.name === ref.name,
      "reference", "工具引用必须匹配同 turn 更早 assistant 的调用 ID 和名称。",
    );
    requireSession(batch === turn.currentBatch && batch.calls[batch.next] === call, "lifecycle", "工具必须按当前原批次顺序执行，不能重叠、越序或重复终止。");

    if (record.type === "tool_start") {
      requireSession(!call.started && !call.terminal, "lifecycle", "同一调用不能重复 tool_start。");
      call.started = true;
      return;
    }

    requireSession(call.started && !call.terminal, "lifecycle", "工具终止需要前置 start，且每项最多一个终止事实。");
    if (record.type === "tool_result") {
      call.terminal = { kind: "result", ok: record.payload.ok };
      batch.next++;

      // 转成业务结果时显式去掉磁盘 callMessageSeq；T6 core 才负责转 ToolMessage。
      const { toolCallId, name, ok, content } = record.payload;
      turn.items.push({ type: "tool_result", result: { toolCallId, name, ok, content } });
    } else {
      // 按判别字段分别复制，既去掉磁盘引用，也保留 TS 对 outcome/category/code 的关联。
      const payload = record.payload;
      const end: ToolEnd = payload.outcome === "failed"
        ? { outcome: "failed", error: payload.error }
        : { outcome: "cancelled", error: payload.error };
      call.terminal = { kind: "end", end };
    }
  }

  /**
   * 在新 turn 或 EOF 时收束当前读模型；没有 end 的合法前缀推导 interrupted。
   * 已知工具结果优先保留；只有有 end 且没有 start 才证明 not_started，其余未知。
   * 不生成磁盘事件；只有 success 的正文进入 20 组窗口，其余正文在换 turn 后释放。
   */
  private finishCurrent(): void {
    const turn = this.current;
    if (!turn) return;

    const calls: ScannedCall[] = [];
    for (const batch of turn.batches.values()) {
      for (const call of batch.calls) {
        if (call.terminal?.kind === "result") {
          calls.push({ ...call.ref, state: "result", ok: call.terminal.ok });
        } else if (call.terminal?.kind === "end") {
          calls.push({ ...call.ref, state: "ended", end: call.terminal.end });
        } else {
          calls.push({ ...call.ref, state: turn.end && !call.started ? "not_started" : "unknown" });
        }
      }
    }

    this.turns.push({
      turnId: turn.turnId, userSeq: turn.userSeq, outcome: turn.end?.outcome ?? "interrupted", calls,
      ...(turn.end ? { end: turn.end } : {}),
    });
    if (turn.end?.outcome === "success") {
      this.successes.push({ turnId: turn.turnId, items: turn.items, ...(turn.runtimeProfile ? { runtimeProfile: turn.runtimeProfile } : {}) });
      if (this.successes.length > 20) this.successes.shift();
    }
    this.current = undefined;
  }

  /**
   * EOF 时交付统计、诊断及成功业务组；首次成功后拒绝追加及重复 finish。
   * accept 曾失败时不能生成摘要；非法重用抛 validator_state，不能交付局部合法历史。
   * 无 I/O、修复或历史执行副作用；中断计数涵盖所有 turn，不覆盖最近 turn 的真实结果。
   */
  finish(): SequenceSummary {
    this.requireActive();
    try {
      this.finishCurrent();
      const summary: SequenceSummary = {
        statistics: {
          lastActivityAt: this.lastActivityAt, turnCount: this.turns.length,
          interruptedTurnCount: this.turns.filter((turn) => turn.outcome === "interrupted").length,
          lastTurnOutcome: this.turns.at(-1)?.outcome ?? null, preview: this.preview,
          ...(this.lastUserProfile ? { lastUserProfile: this.lastUserProfile } : {}),
        },
        recentSuccessfulTurns: this.successes, turns: this.turns,
      };

      // 所有收束成功后才交付；此后两个公开方法都在入口拒绝，不再改变这些数组。
      this.finished = true;
      return summary;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}
