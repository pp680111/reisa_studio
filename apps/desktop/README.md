# @reisa/desktop — 桌面主应用

应用宿主：窗口、导航、工作区、模块加载与页面挂载。不实现模块业务，不直接查询模块数据（架构设计 §3）。

## 目录规划

| 目录                         | 职责                                                                  | 边界                                                            |
| ---------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/main/`                  | Electron 主进程及运行入口                                             | 不加载 React 组件；工具运行层、凭据与数据库连接位于此侧         |
| `src/preload/`               | 有类型的受限 IPC 桥接                                                 | 只暴露类型化接口，遵循 Electron 安全指南                        |
| `src/renderer/shell/`        | 导航、工作区和模块 UI 挂载                                            | UI 不导入 Node、数据库驱动或模块运行层                          |
| `src/renderer/conversation/` | 会话 UI                                                               | 只展示已经通过能力接口返回的内容                                |
| `src/composition/`           | 组合根：`modules.ts`（模块 UI 贡献清单）与 `runtime.ts`（运行时装配） | 只导入各模块公开入口与 `./runtime` 运行入口，不引用模块私有实现 |

已实现 React / TypeScript renderer、Vite 构建、Electron 主进程与受限 preload，以及主进程运行层：

- `src/composition/runtime.ts`：装配 foundation（布局/配置/凭据）、ModuleHost 与内置运行模块清单；按基础配置的 `enabledModules` 激活，激活失败保持 `failed` 并显示原因。
- `src/main/conversations/store.ts`：主应用会话库（`conversations.sqlite`，node:sqlite），持久化会话、消息（含工具调用副本）与工具交互记录。
- `src/main/conversation-manager.ts`：单轮会话编排——历史 + 输入 → `startConversation` → 事件流 → 持久化；同会话禁止并发运行，取消经信号转发。
- `src/main/smoke.ts`：`REISA_SMOKE=1` 时以冒烟模式运行真实主进程（`pnpm test:desktop`）。
- `src/preload/index.ts`：白名单业务通道（会话、设置），无通用 IPC。

renderer 已接入真实 IPC：会话页通过 `src/renderer/bridge.ts` 的类型化桥读写主进程——会话列表/创建/重命名/删除、发送与取消、事件流（文本增量、工具调用与结果）、设置页的模型连接（服务地址 / 模型 ID / API Key，密钥只进凭据存储不回传且经 `safeStorage` 加密）、默认提示词持久化、模块启停（驱动运行层生命周期并保存启用清单）。桥不可用时（浏览器 `pnpm dev` 预览）自动退回本地演示模式，两种模式共用同一套界面。运行中的会话由主进程编排，同会话禁止并发发送；首轮发送后主进程自动把默认标题替换为消息摘要。

会话体验：助手回答以 Markdown 渲染（react-markdown + GFM，CSP 兼容）；附件在真实模式下可用——文本类附件（≤200 KB）内容内联进用户消息随历史保留，其余保存副本到主应用附件目录（`attachments/`，≤10 MB/个、≤30 MB/次，仅登记名称与大小，不进入任何模块数据）；每轮运行后在消息末尾展示服务商上报的 token 用量（仅展示，不构成预算）；侧栏支持会话搜索、双击/按钮重命名、分页加载更多；窗口位置与大小由宿主记忆并在下次启动还原。

`scripts/real-model-test.mjs`：真实模型端到端验证（已用 DeepSeek OpenAI 兼容端点验证通过）。复制用户基础配置到临时目录隔离运行，注册内联 echo 测试模块后发起一轮真实会话，验证连接、真实工具调用与持久化。用法：`node scripts/real-model-test.mjs <userData 路径>`。

打包分发：`pnpm dist` 产出安装包（Windows NSIS / macOS DMG / Linux AppImage，配置见 `electron-builder.yml`）。运行层由 esbuild/vite 完全打包，生产依赖为空，安装包只携带 `dist` 与 `dist-electron`；`pnpm --filter @reisa/desktop dist:dir` 可产出未压缩目录用于快速验证。当前未配置应用图标与代码签名。

使用仓库根目录的 `pnpm dev` 预览，`pnpm dev:desktop` 打开桌面开发窗口；`pnpm build` 后可用 `pnpm start` 启动生产构建，`pnpm test:desktop` 运行 Electron 冒烟。

界面外壳与信息架构见 [界面设计](../../docs/ui-design.md)；主会话与各模块共用 `AppSidebar` 等宿主组件的规范见 [独立模块工作空间](../../docs/module-ui-design.md) §2。
