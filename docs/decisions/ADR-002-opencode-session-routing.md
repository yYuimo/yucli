# ADR-002：OpenCode Go 请求携带会话路由头

状态：`accepted`

日期：2026-10-17

关联阶段：阶段 01 单次模型问答；阶段 02 工具调用往返；阶段 03 REPL 与流式工具循环。

## 背景

第一阶段真实 CLI 联调中，只携带标准 OpenAI 请求头的请求返回 HTTP 400，错误类型为 `MissingSessionID`。服务明确要求 `x-opencode-session` 才能进行路由；原有计划和参考实现均未覆盖这个要求。

## 决定

`OpenCodeGoClient.complete()`/`stream()` 每次生成一个随机 UUID，作为 `x-opencode-session` 请求头。该字段属于提供方适配层，不加入 `LlmRequest`，不进入模型消息，不保存到文件。

## 备选方案与影响

- 不携带该字段会被当前服务拒绝。
- 固定全局值会把独立请求归为同一路由会话，缺乏合理的生命周期。
- 由应用层传入持久 session ID 适合未来多轮场景，但阶段 01 没有历史或会话恢复需求。

阶段 02 仍沿用每次 `complete()` 生成独立 UUID 的规则；一次命令中的多次模型请求不会复用同一个路由头。阶段 02 的真实联调必须验证 OpenCode Go 在这种多轮工具往返下仍能完成请求；若服务要求同一命令复用路由 ID，应在实现前更新本 ADR、契约和测试。

本地 HTTP 测试验证字段存在、符合 UUID 格式且不同请求使用不同值；真实模型联调结果记录在阶段规格。

## 阶段 02 联调记录（2026-10-19）

独立于本地 mock 测试，使用项目工具链运行真实 CLI，模型为 `deepseek-v4-flash`，只读取工作区 README.md。共 2 次 HTTP 请求，状态均为 200；finish_reason 依次为 `tool_calls` 和 `stop`。第二次请求携带 user/assistant/tool 完整历史，read_file 调用和工具结果 ID 配对，2 个路由 UUID 各不相同。CLI 退出码 0、回答非空、stderr 为空，约 8.07 秒。

结果验证了当前账号和模型下“每次 complete 生成新 x-opencode-session”的规则可完成工具往返，因此保持原决定，不改成命令级复用。只记录计数、配对和停止原因，不保留凭证、文件正文或完整模型回答。后续服务行为改变时再更新契约与 ADR，不将单次成功视为所有模型的兼容性保证。

## 阶段 03 联调记录（2026-10-19）

使用现有配置、项目工具链和构建产物 CLI，deepseek-v4-flash：

- REPL 连续两轮文本：2 次 HTTP 200，第二轮角色为 user/assistant/user，2 个路由 UUID 独立；74 个 text_delta、2 个 message_end、2 个独立 usage；finish reason 均 stop。约 6.366 秒，/exit 后退出 0，stderr 为空。
- 单次流式 read_file 往返：2 次 HTTP 200，第二次角色为 user/assistant/tool；1 项 read_file 调用与 tool 结果 ID 配对，2 个路由 UUID 独立；11 个 tool_call_delta、105 个 text_delta、2 个 message_end、2 个独立 usage；finish reason 依次 tool_calls、stop。约 6.511 秒，退出 0，stderr 为空。
- 成功四次请求的 UUID 均不同，均观测到 [DONE]、对象 usage 和 reasoning 字段。reasoning 不渲染；usage 只作为独立事件，中间帧 usage:null 视为未提供统计。

上述成功之前共有 4 次失败 HTTP 200 尝试：3 次因初版误拒 usage:null，修复并补回归；1 次工具流在 message end 后被客户端误拒，整批工具未执行，退出 4。当时记为“不合规 choice/delta 帧、重跑未复现”，现已由用户的抓包与稳定复现确认为合法 usage-only 帧的客户端兼容缺陷，修复记录见阶段 03 规格；未加入自动重试。累计 8 次真实请求，详情见阶段 03 实际结果。

当前结果支持继续逐请求生成 UUID，不改成进程/turn 级共享路由头；usage-only 缺陷属于客户端帧分类问题，不改变路由 UUID 决策；其余协议错误仍按契约失败。观测仅保留元数据，不保存凭证、文件正文、完整响应或模型回答。

## usage-only 修复后的路由复核（2026-10-20）

本次重新运行真实构建产物 CLI：纯文本 1 次 HTTP 200；read_file 往返 2 次 HTTP 200，停止原因依次 tool_calls、stop，调用与结果 ID 配对。三个请求路由 UUID 均不同，继续验证逐请求 UUID 策略，不改变本 ADR 的路由决定。

三个请求均实际收到 finish 后的 choices:[] + usage 对象统计帧；每请求原始 usage 上报 2 份、内部独立 usage 事件 1 次、message_end 1 次，随后 [DONE] 正常。两个进程均 stdout 有回答、stderr 为空、退出码 0。先前“不合规收尾帧”的记录已纠正为客户端 usage-only 兼容缺陷；实现修复与 220 项本地回归验证见阶段 03 实际结果。本轮不保存凭证、文件正文或模型回答。
