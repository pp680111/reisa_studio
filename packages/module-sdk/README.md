# @reisa/module-sdk

模块协议的纯契约包：跨边界类型、Schema 定义与模块上下文接口（架构设计 §5）。

## 计划内容

- `CapabilityDefinition` / `ToolRegistration`：能力声明与处理器注册
- `RuntimeModule` / `ModuleActivation`：模块入口与激活返回
- `ModuleContext`：模块可获得的存储、配置与基础服务句柄；只包含所属模块作用域，不含主应用会话库或其他模块数据
- `ToolExecutionContext`（`invocationId`、`AbortSignal`）、`ToolResult` 与资源引用等可序列化类型
- 统一错误结构与错误码：`CAPABILITY_UNAVAILABLE`、`INVALID_INPUT`、`RESOURCE_NOT_FOUND`、`EXECUTION_FAILED`、`CANCELLED`
- 可生成 JSON Schema 的校验类型（具体校验库待定，架构设计 §12）

## 边界

- 不包含任何 Agent 框架类型，避免模块与框架版本绑定（架构设计 §12）。
- 不引入应用框架运行实例、数据库连接或私有对象；只有可序列化契约。
- 所有包都可依赖本包；本包不依赖其他业务包。

已实现 renderer 安全的 `CapabilityDefinition`、`ModuleContribution`、页面与设置组件 props，提供公开 UI 挂载协议。React 组件类型仅作为类型导入，不包含运行实例。能力 Schema 目前为占位结构；运行处理器、生命周期、模块上下文和真实校验协议后续补齐。
