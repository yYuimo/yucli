# yucli 文档

文档按开发阶段维护，代码和文档一起演进。

## 入口

- [初始架构与开发路线](architecture.md)
- [阶段驱动开发规范](development-workflow.md)
- [接口与契约规范](contracts/README.md)
  - [LlmClient 契约](contracts/llm-client.md)
  - [CLI 行为契约](contracts/cli.md)
- [架构决策记录规范](decisions/README.md)
  - [ADR-001：OpenCode Go 与原生 fetch](decisions/ADR-001-opencode-go-native-fetch.md)
- [Agent 开发报告模板](templates/development-report.md)
  - [ADR-002：OpenCode Go 会话路由头](decisions/ADR-002-opencode-session-routing.md)

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
