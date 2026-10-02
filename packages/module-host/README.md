# @reisa/module-host

模块宿主层：生命周期状态机、能力注册中心与能力调用入口（架构设计 §6、§10）。已实现。

## 已实现

- `ModuleHost`：`register`（内置清单登记）→ `activate` / `deactivate`（五态状态机：disabled / activating / active / deactivating / failed），状态变化经 `onStateChange` 可观察。
- 激活流程：构造模块作用域服务（目录创建 + 内存配置 + 日志）→ `module.activate(context)` → 校验能力集合（命名空间 `moduleId/`、工具名 `moduleId__action`、处理器、输入 Schema）→ 整体注册；任一失败撤销全部注册并进入 `failed`，不产生部分注册。
- `invoke(capabilityId, input, context)`（架构设计 §6.4）：定位注册 → 输入 Schema 校验（TypeBox `Value.Check`；纯 JSON Schema 占位声明退化为最小结构检查）→ 合并取消信号（本次调用 + 模块停用）→ 执行处理器 → 输出 Schema 校验 → 统一错误结构。取消优先于结果：信号已中止的调用不交付成功产物。
- 停用顺序（§10.2）：拒绝新调用（deactivating）→ 撤销工具注册 → 向执行中请求传递取消信号 → 等待 `deactivate()` 结束 → 释放服务句柄。停用不删除业务数据。
- `listEnabledCapabilities()`：全量已启用能力描述（可序列化，不含执行函数）；停用/未激活模块不在集合中——生命周期处理，非相关性筛选（§6.3）。
- `createInvoker()`：与 agent-adapter 的 `CapabilityInvoker` 兼容；宿主组合根把它交给 `startConversation`。

## 边界

- 只提供确定性调用通道；不做推理、不筛选工具子集、不自动重试修改操作。
- 注册中心不存放模块私有数据；不提供跨模块数据库查询或全局文件枚举。
- 默认服务实现（内存配置、控制台日志、目录创建）为占位机制；foundation 落地后替换为真实持久化、凭据与配置服务。

## 测试

`pnpm test` 包含 `test/host.test.mjs`：激活与调用、输入校验、未知能力、处理器异常、停用顺序（拒绝 / 撤销 / 取消 / 等待）、激活失败、注册合规、协议版本、全量提供。
