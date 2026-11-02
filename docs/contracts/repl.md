# REPL 与内存会话契约

状态：`accepted`（阶段 03 已实现并通过本地及真实验证）

阶段 04 扩展状态：`draft`（T8 持久化入口子集已实现验证；T9/T10 尚未验收）

适用阶段：阶段 03，同一进程中的持续对话；阶段 04，带会话保存与恢复的 REPL。

## 命令与生命周期

| 输入 | 行为 | 退出状态 |
| --- | --- | ---: |
| 普通文本 | 追加一轮 user 消息并执行流式 turn | 成功后继续等待 |
| 空行 | 忽略，不请求模型 | 继续等待 |
| `/help` | 输出内置命令帮助 | 继续等待 |
| `/clear` | 清空已完成历史 | 继续等待 |
| `/exit`、`/quit` | 结束 REPL | 0 |
| EOF | 结束 REPL | 0 |
| 等待输入时 Ctrl+C | 结束 REPL | 130 |

`--prompt <text>` 保留单次模式，阶段 03 使用 `stream()` 而不是非流式 `complete()`；`complete()` 和阶段 02 的非流式 `agentLoop` 保留为兼容/测试路径。请求错误、超时、协议错误和主动取消返回阶段 01/02 的模型错误退出码 `4`。

## 历史所有权

REPL 持有 `Message[]`，每轮把不可变快照传给 core。core 不读取全局历史，也不修改传入数组；成功 turn 返回新增消息和最终文本，由 REPL 决定提交。

推荐最多保留最近 20 个已完成 user turn。裁剪以完整 turn 为单位：一轮的 user、assistant 工具调用、tool 结果和最终 assistant 必须一起保留或一起删除。阶段 03 不做 token 估算、摘要或上下文压缩。

## Turn 结果

```ts
interface StreamTurnResult {
  finalText: string;
  modelCalls: number;
  toolResults: readonly ToolResult[];
  appendedMessages: readonly Message[];
  stopKind: "final_text";
}
```

只有成功返回 `StreamTurnResult` 后，REPL 才把 `appendedMessages` 追加到历史。流式中断、超时、协议错误、循环上限或工具取消都抛出稳定错误，不提交半截消息。

## 输出

- 文本 delta 直接按收到顺序写 stdout。
- 工具调用名称和参数不写 stdout；工具错误通过下一轮模型解释，或作为安全错误写 stderr。
- 一个 turn 完成后确保 stdout 以换行结束，再显示下一次输入提示。
- 错误若发生在已输出部分文本之后，先补换行，再向 stderr 写状态。
- 不显示原始 SSE、Authorization、API key、完整工具参数 JSON 或 reasoning。

## 取消

- 正在流式请求/工具执行时 Ctrl+C：取消当前 turn，清理资源，丢弃未完成消息，回到 REPL 提示符。
- 等待输入时 Ctrl+C：退出进程，返回 130。
- turn 执行中不处理新的输入；需要中断当前 turn 时使用 Ctrl+C。`/clear` 只在提示符可用时清空全部已完成内存历史。

## 阶段 04 持久化扩展（draft）

阶段 04 的 REPL 仍由 `bootstrap` 持有最近 20 个成功 turn，但新增一个当前 `SessionWriter` 生命周期：首次非空普通输入才创建会话；`/new` 与 `/clear` 关闭旧会话、清空内存历史，下次普通输入再创建新的 sessionId。旧会话文件保留，不复用其身份。

新增命令的行为如下：

| 输入 | 行为 |
| --- | --- |
| `/resume`、`/resume --all` | 打开共享行式 picker；等待选择时不消费普通问题 |
| `/resume <sessionId>` | 准备候选、取得写锁并重建历史，成功后才替换当前会话 |
| `/new`、`/clear` | 关闭旧 writer，清空历史并回到待创建状态 |

恢复采用“准备候选 → 关闭旧会话 → 替换历史”的顺序。候选 busy、cwd 不匹配、损坏或不支持时，关闭候选资源后保留原会话并允许重试；候选修复、保存、锁或旧会话关闭故障则停止继续接收输入并以存储故障退出。非 TTY 中 `/resume` 不能把下一行当编号，直接报告命令用法并保留历史。

持久化 turn 的历史提交屏障与阶段 03 的临时结果不同：core 交付的每条事实必须等待 `SessionWriter.appendDurable()` 确认；只有 `turn_end(success)` 确认后，REPL 才将完整消息组加入内存历史。失败、取消、超时和保存故障不提交半截历史；保存故障优先于普通取消和退出码。具体 writer、恢复投影、锁和 30 秒/5 秒关闭边界见[会话存储契约](session-store.md)。

上述扩展在完整阶段验收前保持 `draft`；运行入口已按 T8 使用持久化 REPL，前文为阶段 03 历史契约，阶段 04 的历史提交以 CommittedTurnResult 为准。

T7 子集已验证：core/runPersistentTurn 交付保存确认后的 CommittedTurnResult；bootstrap/PersistenceSupervisor 提供可注入的停止输入、业务取消、真实关闭及 5 秒应急退出监督。T8 已接入凭证、SessionCleanup 和监督回调；真实 5 秒强制退出子进程及重启恢复仍归 T9，不把注入监督测试视为已验收真实故障退出。

关联文档：[阶段 03 规格](../specs/phase-03-repl-streaming.md)、[CLI 契约](cli.md)。

## 实现与验证

实现位于 [repl.ts](../../src/bootstrap/repl.ts)，按完整 StreamTurnResult.appendedMessages 分组保存历史，数组快照传给 core；超出 20 组时整体裁剪，不把工具消息单独留存。输入循环在 turn 完成后才处理下一行。[repl.test.ts](../../tests/repl.test.ts) 覆盖源码/构建产物，真实两轮文本、工具往返与 PTY Ctrl+C 结果见阶段 03 规格。


## T8 实现与验证（2026-10-29）

[repl.ts](../../src/bootstrap/repl.ts) 首次非空普通输入才 create；成功凭证确认后才整组追加历史，失败/取消/超时仅保存对应终止并回提示，存储故障停输入并交 [sessionApp](../../src/bootstrap/sessionApp.ts) 监督。/new 与 /clear 先确认旧 close，再清历史并回待创建；旧文件保留，关闭失败退出 5，不接受下一问题。

恢复先准备候选、再关闭旧 writer、再替换为 core 投影的成功历史。REPL 直接 /resume <id> 访问拒绝保留旧会话并允许重试；共享 picker 的访问拒绝保留旧历史、锁和编号快照，仅 a/r 刷新。候选准备期间 Ctrl+C 等 open settle 后关闭候选并返回原提示；EOF 请求结束整个 REPL。旧 close 开始后不因迟到取消撤销切换。保存/修复/关闭/锁服务故障停止交互并退出 5。

[LineInput](../../src/bootstrap/lineInput.ts) 是唯一 readline 消费者，普通输入和 [picker](../../src/bootstrap/sessionPicker.ts) 共用队列。非 TTY 的无 ID /resume 只报告用法，不读取下一行；picker 中 /new 等文字无效，不交给模型。活跃 Ctrl+C 取消本轮，普通提示 Ctrl+C 为 130，picker Ctrl+C 仅取消选择；EOF 正常收尾，关闭故障优先 5。

显式恢复只显示 ID、成功/中断计数与尾部动作；provider/model 只比较最近成功 turn 的 runtimeProfile，无成功 turn 才回退最近 user。所选记录缺摘要保持未知，不借用其他记录；差异或缺摘要在首次新请求前 stderr 提示一次，不要求确认、不进模型、不重读 .env。历史只保留最近 20 个成功完整组，不重跑旧请求或工具。

T8 目标环境 typecheck/lint/build 及 24 文件/1000 项通过，新增 4 文件/172 项；含真实临时 writer、T5 尾部修复、本地 SSE、源码/构建产物 D07 管道停止，以及可控候选准备/旧 close 屏障和取消测试。T9 完整矩阵、真实强制退出/重启故障子进程与人工 TTY 验收、T10 完成审查不在本轮结果内。


## T9 本机集成验收记录（2026-10-30）

本机新增 `sessionProcess`、`sessionProcessFault`、`sessionTerminal` 三个测试文件、56 项；目标 macOS arm64 / Node 24.14.0 / pnpm 10.33.2 全套 **27 文件/1057 项**及 typecheck/lint/build 通过。源码与构建产物均覆盖真实重启/恢复、SIGSTOP/SIGKILL 锁、30 秒超时后保持锁、迟到 I/O 的完成/拒绝、5 秒关闭失败的应急退出、备份/truncate/补 LF 中断后二次打开，以及真实 PTY picker/Ctrl+C/EOF/单边 TTY。模型仅使用本地 mock SSE，存储只使用临时 HOME；故障注入仅存在于 tests preload，没有生产故障开关。

目标机还由 Agent 逐步操作真实终端完成源码创建与构建产物恢复冒烟，验证历史、seq 和释放锁。详细 46 行矩阵、命令、实际文件和限制见[阶段规格 T9 报告](../specs/phase-04-session-persistence.md#t9-集成验收实际结果与开发报告2026-10-30)。用户首轮复核1056/1057，已修正测试共享60 ms请求期限和跨输出管道等待，新增受控管道乱序回归与真实I/O settle诊断；原源码SIGINT 4秒超限仍未定位，托管CI workflow未运行，T9保持partial/尚不能签收；T10/整个阶段完成审查尚未执行，扩展契约仍为 draft。本记录不改变上文接口、存储格式或历史交付语义。
