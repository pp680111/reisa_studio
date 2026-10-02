# @reisa/desktop — 桌面主应用

应用宿主：窗口、导航、工作区、模块加载与页面挂载。不实现模块业务，不直接查询模块数据（架构设计 §3）。

## 目录规划

| 目录 | 职责 | 边界 |
| --- | --- | --- |
| `src/main/` | Electron 主进程及运行入口 | 不加载 React 组件；工具运行层、凭据与数据库连接位于此侧 |
| `src/preload/` | 有类型的受限 IPC 桥接 | 只暴露类型化接口，遵循 Electron 安全指南 |
| `src/renderer/shell/` | 导航、工作区和模块 UI 挂载 | UI 不导入 Node、数据库驱动或模块运行层 |
| `src/renderer/conversation/` | 会话 UI | 只展示已经通过能力接口返回的内容 |
| `src/composition/` | 内置模块清单与组合根 | 只导入各模块公开入口（`index.ts`），不引用模块私有实现 |

已实现 React / TypeScript renderer、Vite 构建、Electron 主进程与受限 preload。使用仓库根目录的 `pnpm dev` 预览，`pnpm dev:desktop` 打开桌面开发窗口；`pnpm build` 后可用 `pnpm start` 启动生产构建。安装包制作与业务运行层后续补充。

界面外壳与信息架构见 [界面设计](../../docs/ui-design.md)；主会话与各模块共用 `AppSidebar` 等宿主组件的规范见 [独立模块工作空间](../../docs/module-ui-design.md) §2。
