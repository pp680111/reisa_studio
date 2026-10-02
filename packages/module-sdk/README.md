# @reisa/module-sdk

模块协议的纯契约包：跨边界类型、Schema 定义与模块上下文接口（架构设计 §5）。

## 内容清单

- `CapabilityDefinition` / `ToolRegistration`：能力声明与处理器注册
- `RuntimeModule` / `ModuleActivation`：模块入口与激活返回
- `ModuleContext`：模块可获得的存储、配置与基础服务句柄；只包含所属模块作用域，不含主应用会话库或其他模块数据
- `ToolExecutionContext`（`invocationId`、`AbortSignal`）、`ToolResult` 与 `ResourceReference` 等可序列化类型
- 统一错误结构与错误码：`CAPABILITY_UNAVAILABLE`、`INVALID_INPUT`、`RESOURCE_NOT_FOUND`、`EXECUTION_FAILED`、`CANCELLED`
- JSON Schema 契约类型；具体 Schema 由模块用校验库（推荐 TypeBox）生成，见 [Agent 框架选型](../../docs/agent-framework-selection.md) §5

## 边界

- 不包含任何 Agent 框架类型，避免模块与框架版本绑定（架构设计 §12）。
- 不引入应用框架运行实例、数据库连接或私有对象；只有可序列化契约。
- 所有包都可依赖本包；本包不依赖其他业务包。

当前已实现：运行时契约（`capability.ts`、`module.ts`、`errors.ts`、`json.ts`）与 renderer 安全的 UI 贡献契约（`contribution.ts`，React 组件仅作类型导入）。`defineCapability` 支持显式传入 `inputSchema` / `outputSchema`。运行处理器、生命周期状态机由 `module-host` 按这些契约实现。内部相对导入带 `.ts` 扩展名，本包可在 Node（原生类型剥离）运行时直接加载，宿主运行层可运行时复用 `toolFailure` 等助手与错误码常量。
