# Agent 框架选型记录

版本：0.3  
日期：2026-10-02  
状态：已确认（2026-10-02）：采用 AI SDK v7 + TypeBox；spike 验证通过，真实服务商冒烟待凭据

本文记录第一阶段 Agent 框架（架构设计 §12、§15 待定项）的调研结论。结论只约束 `packages/agent-adapter` 的适配对象；模块协议与 SDK 不出现任何框架类型。

## 1. 选型需求

来自架构设计 §1、§4.2、§12、§14.2，同时作为接入验收清单：

| 需求               | 说明                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| 普通会话与自然结束 | 由框架管理对话与工具调用循环；循环在模型停止调用工具时自然结束           |
| 无额外硬限制       | 框架默认配置不得引入步数、时间、费用上限；宿主也不新增                   |
| 全量工具接入       | 每次请求携带全部已启用能力定义；框架不得要求或诱导工具子集               |
| 取消               | 用户取消沿 `AbortSignal` 传播到工具处理器                                |
| 消息持久化         | 可取得完整消息历史（含工具调用与结果）写入主应用会话库                   |
| 调用关系保持       | 保持工具调用 ID、参数、结果与消息的对应；不解析自然语言模拟工具调用      |
| 模型无关           | 支持按"服务商连接"配置切换模型服务商（含 OpenAI 兼容端点）               |
| 工程契合           | TypeScript、运行于 Electron main（Node 22+）、事件流可映射到统一会话事件 |

## 2. 候选对比

| 候选                                       | 默认循环限制                                           | 可无上限运行                                                   | 取消                                                  | 模型支持                                                  | 主要顾虑                                                       |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| **AI SDK（`ai`，当前 v7）**                | Agent 抽象默认 `isStepCount(20)`                       | ✅ 官方 `stopWhen: isLoopFinished()`：不触发计数条件，自然结束 | `abortSignal` 选项；工具 `execute` 接收 `abortSignal` | 多服务商（OpenAI / Anthropic / Google / OpenAI 兼容端点） | peer 依赖 zod（随装即可）；v7 事件与字段名需在 spike 中确认    |
| LangGraph.js                               | `recursionLimit` 默认 25，超限抛 `GraphRecursionError` | 只能调大，仍是上限                                             | 可中断                                                | 多服务商                                                  | 图/检查点抽象超出"普通会话"需要；限制语义与 §1 冲突            |
| OpenAI Agents SDK（JS）                    | `maxTurns` 默认 10，超出抛 `MaxTurnsExceeded`          | 只能调大，仍是上限                                             | 可中断                                                | OpenAI 生态为主                                           | 默认限制与 §1 冲突；模型面窄                                   |
| Claude Agent SDK（TS）                     | `maxTurns` 默认 100                                    | 同上                                                           | 可中断                                                | Anthropic 为主                                            | 模型绑定与"服务商连接"配置冲突；面向 CLI/权限审批场景          |
| Mastra                                     | 基于 AI SDK                                            | 继承 AI SDK                                                    | 继承 AI SDK                                           | 继承 AI SDK                                               | 在 AI SDK 之上再包一层 agent/workflow 抽象，本项目只需循环本身 |
| DeepAgents（`deepagents`，基于 LangGraph） | LangGraph `recursionLimit` 上限（默认 25）             | 只能调大，仍是上限                                             | 可中断                                                | LangChain 模型抽象                                        | 默认内置规划 / 文件系统 / 子代理工具，详见 §2.1                |

### 2.1 DeepAgents 专项评估

`deepagents`（LangChain，JS 版为 `deepagents` npm 包）是构建在 LangGraph 之上的"深度智能体"封装，`createDeepAgent` 默认内置三类能力：规划工具（`write_todos`）、虚拟文件系统工具（读取 / 写入 / 编辑）与子代理派生（`SubAgentMiddleware`，通用子代理默认带文件系统工具）。

对照本项目已确认的边界，**不推荐作为第一阶段适配对象**：

1. **内置工具不属于已注册能力**。规划、文件系统与子代理工具由框架注入，不经过能力注册中心校验，也不经能力调用入口执行，破坏 §6.4 的单一执行通道和"全量能力 = 已启用已注册能力"的约定。虽可通过组装自定义 middleware 剥离，但剥离后剩下的就是 LangGraph 的普通 React 循环——回到上一行的候选。
2. **文件系统工具与数据隔离冲突**。通用虚拟文件系统天然跨模块，与 §7"私有数据仅经所有者公开能力访问"的作用域存储模型不可调和。
3. **子代理与规划对应 §2.2 的排除项**。第一阶段明确不包含多 Agent 调度与规划器 / 工作流编排；DeepAgents 的核心价值恰在这些。
4. **循环上限语义**。继承 LangGraph `recursionLimit`（默认 25，调高仍是上限），且存在子代理不传播限制、深层任务静默触发 `GraphRecursionError` 的已知问题。

若未来需要"深度任务"体验，符合架构的做法是将其作为独立模块实现：规划工具、文件工作区注册为该模块的公开能力，走同一注册与调用入口，数据归该模块所有；而不是让框架内置这些行为。

结论：**推荐 AI SDK（`ai` v7）作为适配对象**。它是唯一把"无步数上限、自然结束"作为官方支持用法的候选（`stopWhen: isLoopFinished()`）；其余候选的默认上限需要对抗式配置，且即便调大也仍是上限语义。

## 3. 接入要点

1. 循环配置固定为 `stopWhen: isLoopFinished()`（或等价的"永不计数"条件），禁止使用 `isStepCount` / `maxSteps` / 超时 / 预算类参数。
2. `prepareStep` 等按步定制能力不用于工具子集筛选；每次请求提交全部已启用能力（架构设计 §6.3）。
3. 模块能力定义（纯 JSON Schema）经框架的 JSON Schema 工具包装转换，模块协议不导出框架 `Tool` 类型。
4. 框架工具执行回调接到能力调用入口 `invoke`；框架传入的 `abortSignal` 映射为 `ToolExecutionContext.signal`。
5. 取框架返回的完整消息历史（含工具调用与结果）交主应用持久化；不自行拼装历史。
6. 适配层只做事件映射（`toConversationEvent`）：文本、工具调用、结果、错误、结束。

### 3.1 harness 能力映射（v7 补充调研）

AI SDK v7 的 harness 层能力与本项目边界的对应关系：

| 框架能力                               | 作用                                                                           | 本项目用法                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `ToolLoopAgent`                        | 循环、上下文组装、停止条件一体的 Agent 抽象                                    | 作为适配对象；`HarnessAgent`（跑 Claude Code 等现成 harness）与 `WorkflowAgent`（持久化编排）第一阶段不用 |
| `activeTools` / `prepareStep` 工具定制 | 把某一步限制在指定工具名内                                                     | **弃用**。属工具子集机制，§1 / §6.3 禁止；全量传入且不设 `activeTools`，框架不会默认筛选                  |
| `toolsContext`                         | 按 `contextSchema` 给每个工具下发 typed context（API key、scoped permissions） | 映射模块作用域句柄：凭据不进 prompt、按工具作用域传递，与 `ModuleContext` 设计合拍                        |
| `runtimeContext`                       | 整个 loop 共享的运行态，`prepareStep` 与生命周期回调可读写                     | 携带调用元数据（invocationId、会话标识）；不承载模块私有数据                                              |
| `@ai-sdk/mcp`（`createMCPClient`）     | MCP 工具 ↔ AI SDK 工具自动转换，`tools()` 拉取                                 | 后续 MCP 接入（架构 §12）的转换层；MCP 工具仍须经能力注册与调用入口，不直接进工具集                       |
| 持久化                                 | SDK 不持有存储，消息进出（`responseMessages` / `ModelMessage`）                | 符合 §7.4：主应用拥有会话库，`conversations.sqlite` 由宿主写入                                            |
| 上下文压缩                             | 无强制自动 compaction；干预点在 `prepareStep` / 消息组装                       | 长会话裁剪策略留作宿主的显式产品决策，框架不抢做主（spike 时确认 loop 每步默认输入组装行为）              |
| 工具审批 / reasoning 控制              | v7 新增 agent-level tool approval 等                                           | 第一阶段不用（§2.2 排除独立审批系统），留作后续扩展点                                                     |

## 4. Spike 验证清单（接入前执行，§14.1 第 1 步）

使用 `ai` 包的测试工具（Mock 模型，无网络）验证：

1. 一次请求提交全部工具定义，工具数量无截断、无静默筛选。
2. 多步工具循环运行至自然结束，不触发任何步数上限。
3. 中途 `abortSignal` 取消：循环停止、得到结构化错误事件、工具处理器收到同一信号。
4. 工具调用 ID / 参数 / 结果在消息历史中保持对应。
5. 事件流可完整映射为统一会话事件（文本 / 工具调用 / 结果 / 错误 / 结束）。
6. 真实服务商冒烟（待凭据）：OpenAI 兼容端点 + 工具调用。

### 4.1 验证结果（2026-10-02，`ai@7.0.127`）

第 1–5 项已通过（Mock 模型，无网络；测试见 `packages/agent-adapter/test/spike.test.mjs`，`node --test` 运行）：

| 清单项                  | 结果                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| 1. 全量工具提交         | ✅ 每次模型调用的工具集合均为完整集合，无默认筛选                            |
| 2. 无步数上限           | ✅ 31 步循环（30 次工具调用 + 收尾）自然结束，`finishReason: stop`           |
| 3. 取消传播             | ✅ 工具 `execute` 收到已中止信号；取消后未发起第二次模型请求                 |
| 4. ID / 参数 / 结果对应 | ✅ `tool-call` 与 `tool-result` 的 `toolCallId` 一致，输出为处理器真实返回值 |
| 5. 事件映射             | ✅ `fullStream` 覆盖 text / tool-call / tool-result / finish，无 error       |
| 6. 真实服务商冒烟       | ⏳ 待凭据                                                                    |

适配层实现须知（spike 确认的 v7 行为）：

- 工具 `execute` 选项为 `{ toolCallId, messages, abortSignal, context, experimental_sandbox }`；`abortSignal` 仅在调用方向 `streamText` 传入信号时才下发——适配器必须始终传入（宿主为每次运行创建 `AbortController`，即使暂无取消请求）。
- `result.response.messages` 仅含最后一步消息；完整历史须经 `result.steps` 逐步累积（每步消息保留工具调用与结果的对应关系）。
- 工具输出在消息历史中被包装为 `{ type: 'json', value }` 信封；结果展示前需解包。
- 模型流部件的 `finishReason` 为 `{ unified, raw }` 结构，`usage` 为嵌套结构（`inputTokens.total` 等）。

## 5. 校验库推荐

推荐 **TypeBox（@sinclair/typebox）**：Schema 即 JSON Schema，与 `CapabilityDefinition.inputSchema` 及框架的 JSON Schema 工具直接衔接；`Value.Check` 提供编译式校验；支持 Standard Schema 接口。备选 Zod 4（原生 `z.toJSONSchema()`），若更偏好其 DX 可替换，但模块作者将多一次转换步骤。

## 6. 参考链接

- [AI SDK：Agents Loop Control](https://ai-sdk.dev/docs/agents/loop-control)（`stopWhen` / `isLoopFinished` / `isStepCount`）
- [AI SDK：Runtime and Tool Context](https://ai-sdk.dev/docs/ai-sdk-core/runtime-and-tool-context)（`runtimeContext` / `toolsContext`）
- [AI SDK：createMCPClient 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client)
- [AI SDK：Agents Overview](https://ai-sdk.dev/docs/agents/overview)
- [OpenAI Agents SDK (JS)：Running Agents](https://openai.github.io/openai-agents-js/guides/running-agents)
- [Claude Agent SDK 示例（maxTurns 默认 100）](https://github.com/anthropics/claude-agent-sdk-demos/blob/main/hello-world/README.md)
- [LangGraph.js recursionLimit 默认 25 的行为](https://github.com/langchain-ai/langgraphjs/issues/1524)
- [TypeBox vs Zod 选型对比](https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod)
- [DeepAgents（LangChain JS）概览](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [deepagents npm 包](https://www.npmjs.com/package/deepagents)
- [DeepAgents 子代理不传播 recursion_limit 的问题](https://github.com/langchain-ai/deepagents/issues/1698)
