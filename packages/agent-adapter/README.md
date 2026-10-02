# @reisa/agent-adapter

Agent 框架适配层（架构设计 §4.2）。适配对象为已确认的 AI SDK v7，选型对比与 spike 验证见 [Agent 框架选型](../../docs/agent-framework-selection.md)。

## 已实现

- `startConversation(options)` → `ConversationSession`：提交会话历史、模型、全量能力描述（可序列化，不含执行函数）与调用入口，返回统一事件流与运行结果。
- `ConversationSession.cancel()`：转发用户取消信号；内部 `AbortController` 与宿主传入信号合并，取消后框架不再发起后续模型请求。
- `toFrameworkTool` / `toFrameworkTools`：能力定义 → 框架工具；执行回调绑定 `CapabilityInvoker`（能力调用入口，后续由 module-host 提供），每次执行生成 `invocationId` 并携带取消信号。
- 统一事件流（`events`）：文本（`text-delta`）、工具调用、结果（已解包 `{ type: 'json', value }` 信封）、错误（归一为公开错误负载）与结束（`stop` / `abort` / `error`）。
- `createOpenAICompatibleModel`：OpenAI 兼容端点的模型构造入口，凭据由基础连接服务传入。

## 边界

- 不自行规划任务、不新增步数/时间/费用限制：循环固定 `stopWhen: isLoopFinished()` 自然结束。
- 不使用 `activeTools` / `prepareStep` 做工具子集筛选；每次请求提交全部注册能力。
- 对 `@reisa/module-sdk` 使用类型定义与错误码常量；适配层只接触可序列化能力描述，执行函数与模块私有对象留在运行层（架构设计 §6.2）。
- 框架类型（`Tool`、`ModelMessage`、`LanguageModel`）只在本包与宿主侧使用，不进入模块协议。

## 实现须知（spike 确认，选型文档 §4.1）

- 必须始终向框架传入 `abortSignal`，否则工具 `execute` 收不到取消信号。
- 完整消息历史经 `result.steps` 逐步累积；`result.response.messages` 仅含最后一步。
- 工具输出在消息历史中为 `{ type: 'json', value }` 信封；事件流已解包。
- 取消/失败路径下 `outcome.messages` 可能不完整，宿主应同时持久化事件流已确认的内容。

## 测试

- `pnpm test`：包含本包 `test/adapter.test.mjs`（文本会话 / 工具调用 / 能力失败 / 取消 / 工具转换）。
- `pnpm --filter @reisa/agent-adapter test:spike`：框架行为 spike（选型文档 §4 清单）。
- 真实服务商冒烟（OpenAI 兼容端点 + 工具调用）待凭据后执行。
