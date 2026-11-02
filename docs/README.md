# yucli 文档

文档按开发阶段维护，代码和文档一起演进。

## 入口

- [初始架构与开发路线](architecture.md)
- [阶段驱动开发规范](development-workflow.md)
- [阶段 01：单次模型问答与四层实现结果](specs/phase-01-single-model.md)
- [阶段 02：只读文件工具与最小 Agent Loop](specs/phase-02-read-file-agent-loop.md)
- [阶段 03：持续对话与流式输出](specs/phase-03-repl-streaming.md)
- [阶段 04：会话保存与恢复（implementing；T9 partial、未签收；原 SIGINT 超限仍待定位，托管 CI 未运行；T10 本地预收口完成，最终签收待 CI）](specs/phase-04-session-persistence.md)
- [会话持久化调研报告（已收口）](research/session-persistence-research.md)
- [接口与契约规范](contracts/README.md)
  - [LlmClient 契约](contracts/llm-client.md)
  - [OpenCode Go HTTP 接口契约](contracts/opencode-go-http.md)
  - [CLI 行为契约](contracts/cli.md)
  - [工具执行契约](contracts/tool-execution.md)
  - [流式模型与 SSE 契约](contracts/streaming.md)
  - [REPL 与内存会话契约](contracts/repl.md)
  - [会话存储契约](contracts/session-store.md)
- [架构决策记录规范](decisions/README.md)
  - [ADR-001：OpenCode Go 与原生 fetch](decisions/ADR-001-opencode-go-native-fetch.md)
  - [ADR-002：OpenCode Go 会话路由头](decisions/ADR-002-opencode-session-routing.md)
  - [ADR-003：阶段 02 顺序只读工具循环](decisions/ADR-003-phase-02-minimal-agent-loop.md)
  - [ADR-004：阶段 03 流式事件与内存 REPL](decisions/ADR-004-phase-03-streaming-repl.md)
  - [ADR-005：暂不抽取 OpenAI 兼容客户端基类](decisions/ADR-005-defer-openai-compatible-base-client.md)
  - [ADR-006：严格 JSONL 日志与单写者恢复（accepted）](decisions/ADR-006-session-persistence.md)
- [非主流程代码清单（历史与降级路径）](legacy-paths.md)
- [Agent 开发报告模板](templates/development-report.md)

## 目录约定

```text
docs/
├── architecture.md
├── development-workflow.md
├── specs/              # phase-XX-<name>.md
├── contracts/          # 跨模块接口和数据协议
├── decisions/          # ADR-XXX-<name>.md
└── templates/          # 新阶段、新契约、新 ADR 的模板
```

阶段完成后，阶段文档保留实际结果；不把已经发生的设计和验证另写成脱离代码的总结。
